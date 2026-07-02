# x-search task JSON 截断问题:诊断报告

> **日期**:2026-07-02
> **性质**:诊断会话,**未改任何代码**(工作区零改动,仍在 v2.2.0 / HEAD `4ac084b`)
> **读者**:接手 ugk task 系统的同事
> **一句话结论**:用户报告"特殊符号破坏 JSON",经尸体确诊**真凶是输出被截断,不是特殊字符**。系统稳定,暂不改动,留待复现后决策。

---

## 1. 问题是怎么报上来的

用户跑 `/task run x-search <msi 最新1小时>`,结果 JSON 报错不合法。用户记忆归因为"某个用户名里有爱心符号,把 JSON 格式破坏了",并提出:**序列化正确性应该是基建处理的,不该指望用户设计 task 时注意。**

这个方向感(基建兜底)是对的,但"特殊字符"这个归因是错的。我们没贸然改基建,而是去找那次 run 的产物尸体来确诊。

---

## 2. 确诊:不是特殊字符,是截断

### 2.1 尸体检验(实测,非推断)

拿到那次 run 的输出文件,`JSON.parse` 直接跑:

```
错误消息: Unexpected end of JSON input
文件总长: 16572 字符
```

`Unexpected end of JSON input` 这个报错**有歧义** —— 容易让人以为是"坏字符让解析提前结束",但它的真实意思是**"文件没写完就结束了"**。这是误判的源头。

### 2.2 截断的铁证

| 字段 | 值 | 说明 |
|---|---|---|
| `benchmark.filteredRows` | **56** | worker 知道抓到了 56 条 |
| `benchmark.rowsReturned` | **56** | worker **自认为**写了 56 条 |
| 文件里实际完整对象数 | **37** | 只写了 37 条 |
| 第 38 条断点 | `"author": "` | 戛然而止,没有值、没有闭合引号 |
| 文件结尾 | 无任何闭合(`]` `}` 都没有) | 整个 JSON 没收尾 |

**矛盾点**:`benchmark` 完整写进去了(worker 知道有 56 条,且 `totalRunMs: 51601` 表明抓取循环跑完了),但 `results` 数组只写了 37 条就在第 38 条的 `author` 字段中间断了。**worker 知道该写多少,但没写完。**

### 2.3 "爱心符号"在尸体里根本不存在

扫了 37 条完整对象,**没有一个爱心/emoji**。最后一条(第 38 条,被截断的那条)来自 `@strawbrynaio`,内容是印尼语 "msi raguu",无任何特殊字符。用户记忆中的"爱心"是**归因偏差** —— 看到 JSON 报错 + 正好注意到某个特殊字符,就把两者关联了。

---

## 3. 根因推断(基于证据链)

### 3.1 截断发生在哪一层

排除法,逐个看可能的切断点:

| 假设的切断点 | 是否成立 | 理由 |
|---|---|---|
| `fs.writeFileSync` 写盘失败 | ❌ 排除 | writeFileSync 原子写整个字符串;写盘失败会空文件/报错,不会精确停在半句话 |
| bash 命令行长度上限 | ❌ 排除 | Windows 命令行 32KB,文件才 17KB |
| CDP evaluate 返回值上限 | ❌ 排除 | dump-result.js 已分块(每块 50),单块远小于上限 |
| worker 进程被 kill/超时 | ❌ 排除 | benchmark 完整(totalRunMs 有值),说明抓取跑完了 |
| **LLM 输出 token 上限** | ✅ 唯一成立 | 见下 |

**剩下唯一站得住的是:worker 把整个 JSON 当文本重新生成,撞 LLM 输出 token 上限,被硬切。**

### 3.2 因果链

```
高频词(msi)+ 短时间窗(1h)= 结果密度大
  → 56 条,多条长文本(股市分析/韩日文/长 URL)
    → worker 抓完后,benchmark 完整(filteredRows:56 写进去了)
      → 进入"写输出文件":worker 要把整个对象重新生成为文本
        → 整个 JSON 当字符串逐字吐出 → 撞 max_tokens 输出上限
          → 输出被硬切 → content 变量是不完整字符串(停在 "author": ")
            → fs.writeFileSync 忠实写下这段不完整字符串
              → 文件停在 37.5 条,无闭合
                → verify: JSON.parse 失败 → FAIL
```

**本质**:worker 用"生成文本"的方式去做"序列化数据"的活,被 token 上限物理截断。

### 3.3 为什么 17 个历史文件都没事,这次撞了(自洽性验证)

扫了 `~/AppData/Local/Temp` 下 17 个历史 `x_search_results.json`:

```
历史最大文件: 1.0 KB(2 条结果)
尸体文件:    17.0 KB(应写 56 条,实写 37 条就断了)
```

**历史 17 个文件全部 ≤ 1KB,尸体是它们的 17 倍。** 损坏精确发生在数据量第一次变大的时候。如果是特殊字符问题,小文件出现特殊字符也会坏;但小文件全好端端 —— 只有数据量爆表的那个坏了。这强力支撑"token 上限截断"推断。

### 3.4 推断的诚实边界

有一环无法直接观测:worker 具体是用 `node -e "fs.writeFileSync(path,'<整个 JSON>')"` 单行写,还是多行脚本写。但**两种方式都要逐字吐出整个 JSON,都受 max_tokens 约束**,所以这个不确定性不影响"截断"结论,只影响截断点位置的细节解释。

---

## 4. 现状机制行为(已读源码确认)

`extensions/task/task.ts:1251-1299` 的 `runTaskWithRetry`:**worker → verify → checker → 重跑** 循环,`maxRetry = 3`(最多 4 次)。

```
第1次 worker 写文件(被截断)
  → verify FAIL(Unexpected end of JSON input)
    → checker 分析失败,生成 feedback
      → 第2次 worker(带 feedback 重跑)
        → ... 最多 4 次都 FAIL 才真正结束
```

**回答"直接失败还是打回":打回重跑,不是直接结束。**

但要诚实补一句:**针对这个截断类问题,重跑大概率无效。** checker 的 feedback 是"JSON 被截断,请写完整"这类,而根因(token 上限 + 数据量 + 生成方式)重跑时**全部不变**。第 2/3/4 次大概率撞同样的墙。重试能救偶发错误,救不了系统性物理限制。最终 4 次 FAIL 后才结束。

---

## 5. 为什么暂不改动

1. **v2.2.0 刚发布,551/551 测试绿,系统稳定**。贸然改基建风险高。
2. **这是偶发,不是系统故障**。17 个历史文件全过,只有大数据量那次撞了。
3. **单次样本不足以支撑"改基建"的决策**。需要第二次复现,确认它是可复现的系统问题,而不是单次边界 case。
4. **第一性原则**:确证值得改再改,不为单次偶发重写基建。

---

## 6. 下次遇到怎么快速确诊(不用重走弯路)

看两个特征就够,不用做整个调查:

1. **verify 报 `Unexpected end of JSON input`** + 文件结尾是半截值/没有闭合 `]}` → **截断,不是字符问题**
2. **`benchmark.filteredRows` 远大于实际 `results.length`** → worker 知道有多少条但没写完 → 坐实是输出阶段截断

如果第二次确诊是同一个坑(截断),那时候再谈改。方案空间(供未来参考):
- **路径 A(事后自愈)**:worker 写完 → 机制扫 `*.json` → parse 失败尝试修复。**对截断无效**(信息已丢失,无法猜出没写的 19 条),只能更早 FAIL + 更好的错误。
- **路径 B(CDP→文件直连)**:加 worker 工具,内部 evaluate + `JSON.stringify` + writeFileSync,数据不经 worker 输出 token。**治本**:绕开 token 上限这个物理限制。顺带解决特殊字符。代价是改 worker 工具体系。
- **路径 C(增量写)**:改 skill.md 第 7 步,每抓一块就 append 写,而不是攒齐再一次性生成。治标,仍依赖 worker 遵守指令。

---

## 7. 一个已被证伪但值得记住的初判

会话初期,基于"特殊字符破坏 JSON"的错误前提,我曾分析过三条路(事后自愈 / CDP 直连防字符 / 两个都做),并讨论了 worker 工具授权机制、CDP evaluate 返回值路径(`chrome-cdp/index.ts:192` 是 `JSON.stringify(result,null,2)` 进 content)等。

**这些都建立在错误前提上,不直接适用**。但其中对 worker 工具系统的调研是准确的(加工具 = `defineTool` + 在 `extensions/index.ts` 注册一行,worker 子进程因 `-e extensions/index.ts` 自动可见),未来真要走路径 B 时可复用。调研结论不在此赘述,需要时 grep 本会话历史或重新调研。

---

## 8. 相关文件索引

| 文件 | 作用 |
|---|---|
| `~/.pi/agent/tasks/x-search/skill.md` | worker 执行手册(第 7 步"写输出文件"是截断发生处) |
| `~/.pi/agent/tasks/x-search/verify.mjs` | 机器验收(`parseJsonText` 第一个抓 JSON.parse 失败) |
| `~/.pi/agent/tasks/x-search/scripts/dump-result.js` | 分块 dump(已是 50 条/块,但第 7 步又退化成全量生成) |
| `extensions/task/task.ts:1251-1299` | `runTaskWithRetry` 循环(打回重跑逻辑) |
| `extensions/chrome-cdp/index.ts:192` | evaluate 返回值 `JSON.stringify` 进 content(数据必经 LLM) |
| `docs/handoff/2026-06-28-x-search-task-and-task-creator-hardening.md` | x-search task 的历史背景 |

---

## 9. 会话状态收尾

- **代码改动**:零(`git diff` 全空,工作区干净)
- **版本**:仍在 v2.2.0,HEAD `4ac084b`,与 origin/main 同步
- **唯一产出**:本报告(诊断结论,供未来接手)
- **建议**:下次遇到同样现象,按 §6 快速确诊;确认可复现后再启动改基建的决策流程
