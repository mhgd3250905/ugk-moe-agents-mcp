# Handoff — linkedin-search task(迁移旧 skill 到纯 task 架构)

> 日期:2026-06-28
> 关联:`x-search` task(同范式,已稳定运行)
> 代码基线:main `a6719ed`(含 UI 语言 PR #21),477/477/0
> 工作树:本会话改动均在 `~/.pi/agent/tasks/linkedin-search/`(user scope,跟用户走,不进 repo),repo 无 tracked 改动

---

## 本次做了什么

把旧的 `linkedin-search-latest` skill(host-bridge + proxy:3456 + Docker sidecar 架构)迁移成**纯 task 架构**(UGK chrome_cdp 工具),沿用 x-search 验证过的范式,保留 LinkedIn 的全部定制化方案。

### 为什么是纯 task(不是 skill)

同 x-search 的决策:用户要"稳定可交付 + headless + 并行",skill 的灵活触发用不上。task 精准命中。详见 x-search handoff。

### LinkedIn vs X 的关键差异(决定迁移细节)

| 维度 | x-search | linkedin-search |
|---|---|---|
| 浏览器接入 | chrome_cdp | **旧 host-bridge → 已迁 chrome_cdp** |
| 滚动容器 | window 全页滚 | **`<main id="workspace">` 容器滚动 + 无限滚动/按钮双策略 + bounce 反爬** |
| 时间解析 | ISO datetime | **相对时间标签多语言解析**(11h/3d/2周/2个月) |
| 结果 URL | status 链接 | **三级优先级**:/feed/update/ > /posts/-activity- > 内部链接 + safety/go 解码 + 作者链接兜底 |
| 作者名 | span 文本 | **logo-only 公司账号从正文开头回退提取** |
| 时间范围 | rolling/calendar 任意 | **仅 days(过去 N 天)**,LinkedIn URL 只支持固定档(past-24h/week/month) |
| 登录处理 | 简单 | **专门 preflight**(登录页/captcha/protechts 检测) |

## 交付:`~/.pi/agent/tasks/linkedin-search/`

五件套 + 3 scripts:
- `taskbook.json` — 索引,description 含调用前确认引导(同 x-search:keyword + days 必须问用户)
- `spec.json` — 需求
- `contract.json` — runtimeInput: keyword/timePhrase/days/startIso/endIso/maxScrolls(扁平标量,dispatcher 算)
- `skill.md` — worker 执行手册(chrome_cdp 接入,7 步流程)
- `verify.mjs` — 产物层语义校验(已自验 happy/empty/login_required/truncation 四路径)
- `scripts/dom-collector.js` — 页面内 DOM 收集器(三级 URL 优先级 + 作者名回退 + 相对时间解析)
- `scripts/scroll-and-collect.js` — 页面内长 evaluate 滚动采集(workspace 容器 + 双策略 + bounce)
- `scripts/dump-result.js` — 分块取全量(同 x-search 范式)

## 迁移要点(架构升级:旧 web-access → chrome_cdp)

1. **host-bridge → chrome_cdp**:旧 skill 用 `requestHostBrowser` + `proxyRequest(127.0.0.1:3456)` 调 CDP,新 task 全部走 UGK `chrome_cdp` 工具。skill.md 明确禁止 host-bridge/proxy:3456/Docker sidecar/web-access。
2. **主进程脚本 → 页面内长 evaluate**:旧 skill 的 `collectPosts` 循环在 node 主进程(经 proxyRequest 调 CDP),新 task 把它改造成 `scroll-and-collect.js`,作为**一个长 evaluate(timeoutMs 180000)**在页面内跑完整循环。这是 x-search 验证过的范式。
3. **保留全部 LinkedIn 定制**:`#workspace` 容器滚动、随机小步(20-40%)、按钮双策略(25% 概率)、bounce 反爬、三级 URL 优先级、safety/go 解码、作者名回退、相对时间多语言解析 —— 全部在 scripts/ 里,worker 只管调。

## 数据落地范式(同 x-search)

```
worker → chrome_cdp evaluate scroll-and-collect.js → resolve 返回摘要+预览(小)
       → chrome_cdp evaluate dump-result.js 分块(offset+=50)→ append 写 $TASK_OUTPUT_DIR
       → worker 按 [startMs,endMs) 过滤(相对时间标签解析)
       → 进程退出(上下文销毁,不撑爆)
```

零 HTTP、零弹窗、零 host-bridge。worker 是一次性进程。

## 测试基线

- repo:477/477/0(零破坏,本 task 在 user scope 不进 repo)
- linkedin-search verify 四路径自验全过:happy / empty / login_required / truncation(精确抓 results≠inWindow)

## 待验证项(用户实操)

⚠️ **必须新开 ugk 进程**。

**主测试**:
```
/task run linkedin-search "medtrum" "最近30天"
/task run linkedin-search "insulin pump" "past 7 days"
```
观察:
1. dispatcher 算 days/startIso/endIso(基于当前日期)
2. worker 用 chrome_cdp navigate 到 LinkedIn 搜索页
3. 登录墙/captcha → 照实上报 login_required(不编造结果)
4. 滚动采集成功 → results 全量落地,$TASK_OUTPUT_DIR/linkedin_search_results.json 生成
5. verify PASS

**关键观察点**:LinkedIn 登录态 —— 如果受控 Chrome 没登录 LinkedIn,会直接 login_required。这是 LinkedIn 特性(比 X 严)。需要确保受控 Chrome 已登录 LinkedIn。

## 架构债(记录)

无新增。沿用 x-search 范式,机制层零改动。

## 后续优化:dateRange 三档重构(用户反馈后改)

用户指出:**只用 LinkedIn 原生三档时间过滤**(past-24h / past-week / past-month),不要自造 days→档位换算。

**重构内容**(把自造的 days 换算改成原生档位枚举):
- contract runtimeInput:`days` 字段 → 改成 `dateRange` 枚举(past-24h/past-week/past-month)
- dispatcher 职责:把用户自然语言时间意图**归并到覆盖它的最近档位**(不漏):
  - ≤24h(今天/最近几小时)→ past-24h
  - >24h 且 ≤7d(最近三天/上周)→ past-week
  - >7d(一个月/最近两周/90天 → 向上归并)→ past-month
- skill.md 查询构造:直接用 `datePosted=%5B%22<dateRange>%22%5D`,不自造其他值
- verify 新增:dateRange 必须是三档之一(非法值如 past-year → FAIL)
- startIso/endIso 仍保留(past-24h→now-24h 等),用于 worker 本地二次过滤

**已自验**:happy/empty/login_required/truncation + 非法 dateRange 拒绝,全过。全量测试 477/477/0。

## 参考

- 同范式 task:`~/.pi/agent/tasks/x-search/`(已稳定运行,详见 x-search handoff)
- task-creator SKILL.md 的"迁移旧 skill 标准动作"节 —— 本次迁移就是它的实例
