import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// verify 只管"产物层语义校验":worker 是否按 contract 产出了有效结果。
// 输入层校验(required 字段存在/有效)由 dispatcher 门禁负责(task-dispatcher.ts),
// 这里不重复 —— dispatcher 失败时 worker 根本拿不到 runtimeInput,task 早就 throw 了。
const failures = [];
function fail(assertion, expected, actual, hint) { failures.push({ assertion, expected, actual, hint }); }
function parseJsonText(text, label) {
  try { return JSON.parse(text); }
  catch (error) { fail(label + ' is valid JSON', 'parseable JSON', error.message || String(error)); return null; }
}
function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function parseTime(value, label) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) fail(label + ' is parseable date-time', 'valid date-time', value);
  return ms;
}

const outDir = process.env.TASK_OUTPUT_DIR || '.';
const outputFile = join(outDir, 'x_search_results.json');
const taskInput = parseJsonText(process.env.TASK_INPUT || '{}', 'TASK_INPUT') || {};
const keyword = String(taskInput.keyword ?? '');

if (!existsSync(outputFile)) {
  fail('output artifact exists', 'x_search_results.json', 'missing', 'worker must write the main JSON artifact');
} else {
  const data = parseJsonText(readFileSync(outputFile, 'utf8'), 'x_search_results.json');
  if (data) {
    // 顶层字段
    for (const field of ['normalizedKeyword', 'rawQuery', 'timeWindow', 'cutoffIso', 'searchUrl', 'method', 'benchmark', 'results']) {
      if (!(field in data)) fail('output has field ' + field, 'present', 'missing');
    }

    // keyword 契约(产物层:worker 是否用了正确的 keyword)
    if (String(data.rawQuery ?? '') !== keyword) fail('rawQuery matches TASK_INPUT.keyword', keyword, data.rawQuery);
    if (!String(data.normalizedKeyword ?? '').trim()) fail('normalizedKeyword is non-empty', 'non-empty string', data.normalizedKeyword);

    // timeWindow 契约(产物层:worker 是否守信地用了 dispatcher 算的值 + 组装正确)。
    // 注意:startIso 能否 parse 成日期是"产物语义"——dispatcher 可能输出残片字符串(机制层无法通用判),
    // worker 若原样用,这里抓到"startIso 不是有效日期",这正是 verify 该干的。
    let startMs = NaN;
    let endMs = NaN;
    if (!isPlainObject(data.timeWindow)) {
      fail('timeWindow is object', 'object with raw/mode/startIso/endIso/canonical', data.timeWindow, 'worker must assemble timeWindow from flat input fields');
    } else {
      const tw = data.timeWindow;
      for (const field of ['raw', 'mode', 'amount', 'unit', 'startIso', 'endIso', 'canonical']) {
        if (!(field in tw)) fail('timeWindow has field ' + field, 'present', 'missing');
      }
      if (!['rolling', 'calendar', 'calendar_to_now'].includes(String(tw.mode))) {
        fail('timeWindow.mode is valid', 'rolling|calendar|calendar_to_now', tw.mode);
      }
      if (!['hour', 'day', 'week', 'month'].includes(String(tw.unit))) {
        fail('timeWindow.unit is valid', 'hour|day|week|month', tw.unit);
      }
      if (!Number.isFinite(Number(tw.amount)) || Number(tw.amount) <= 0) {
        fail('timeWindow.amount is positive number', 'positive number', tw.amount);
      }
      // 产物语义:startIso/endIso 必须是有效日期(抓 dispatcher 残片 + worker 现编)
      startMs = parseTime(tw.startIso, 'timeWindow.startIso');
      endMs = parseTime(tw.endIso, 'timeWindow.endIso');
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && !(startMs < endMs)) {
        fail('timeWindow.startIso < timeWindow.endIso', 'start before end', { startIso: tw.startIso, endIso: tw.endIso });
      }
      const cutoffMs = parseTime(data.cutoffIso, 'cutoffIso');
      if (Number.isFinite(cutoffMs) && Number.isFinite(startMs) && cutoffMs !== startMs) {
        fail('cutoffIso equals timeWindow.startIso', tw.startIso, data.cutoffIso);
      }
    }

    // searchUrl 编码正确(产物层:worker 是否构造了正确的 X URL)
    const expectedUrl = 'https://x.com/search?q=' + encodeURIComponent(String(data.normalizedKeyword ?? '')) + '&src=typed_query&f=live';
    if (String(data.searchUrl ?? '') !== expectedUrl) fail('searchUrl is encoded X Latest URL', expectedUrl, data.searchUrl);

    // method 记录了来源(产物层)
    const method = String(data.method ?? '').toLowerCase();
    if (!method.includes('x-search') && !method.includes('x-searcher')) fail('method records x-search', 'contains x-search', data.method);
    if (!method.includes('chrome') && !method.includes('cdp')) fail('method records Chrome/CDP', 'contains chrome or cdp', data.method);

    // benchmark 结构(产物层)
    if (!isPlainObject(data.benchmark)) {
      fail('benchmark is object', 'object', data.benchmark);
    } else {
      for (const field of ['stopReason', 'score', 'grade', 'cutoffReached', 'anchorScrolls', 'rowsInspected', 'validRate', 'filteredRows']) {
        if (!(field in data.benchmark)) fail('benchmark has field ' + field, 'present', 'missing');
      }
      if (!Number.isFinite(Number(data.benchmark.score))) fail('benchmark.score is finite', 'number', data.benchmark.score);
    }

    // results 数组契约(产物层:全量落地 + 每条有效 + 落在时间窗内)
    if (!Array.isArray(data.results)) {
      fail('results is array', 'Array', typeof data.results);
    } else {
      // 全量落地一致性:results 条数应等于 benchmark.filteredRows(不丢)
      if (data.benchmark && Number.isFinite(Number(data.benchmark.filteredRows))) {
        if (data.results.length !== Number(data.benchmark.filteredRows)) {
          fail('results count matches benchmark.filteredRows (full dump, no loss)',
            data.benchmark.filteredRows, data.results.length,
            'dump all chunks; do not truncate');
        }
      }

      const windowToleranceMs = 5 * 60 * 1000; // allow small run-time/clock drift around "now" windows
      data.results.forEach((item, index) => {
        if (!isPlainObject(item)) {
          fail('results[' + index + '] is object', 'object', item);
          return;
        }
        for (const field of ['postedAt', 'text', 'url']) {
          if (!(field in item)) fail('results[' + index + '] has field ' + field, 'present', 'missing');
        }
        if (!String(item.author ?? '').trim() && !String(item.handle ?? '').trim()) {
          fail('results[' + index + '] has author or handle', 'author or handle present', { author: item.author, handle: item.handle });
        }
        const postedMs = parseTime(item.postedAt, 'results[' + index + '].postedAt');
        if (Number.isFinite(postedMs) && Number.isFinite(startMs) && Number.isFinite(endMs)) {
          if (postedMs < startMs - 1000 || postedMs >= endMs + windowToleranceMs) {
            fail('results[' + index + '].postedAt is within timeWindow [startIso,endIso)',
              { startIso: data.timeWindow?.startIso, endIso: data.timeWindow?.endIso }, item.postedAt,
              'anchor-scroll.js must filter by startIso and endIso');
          }
        }
        if (!/\/status\/\d+/.test(String(item.url ?? ''))) {
          fail('results[' + index + '].url is X status link', 'contains /status/<digits>', item.url);
        }
      });
    }
  }
}

if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('PASS');
