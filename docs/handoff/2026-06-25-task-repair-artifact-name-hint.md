# repair 提示:文件不存在时优先查产物名一致性

> **交接对象**:接手 task 模块的同事。
> **背景**:用户反馈某次 `/task run` 失败后反复修不好,根因是 skill/contract/verify 三处产物名写岔了(详见 `docs/handoff/2026-06-25-task-artifact-name-consistency.md`)。系统只报"文件不存在"这个症状,没引导回到"统一产物名"的根因,导致 agent 围着症状改。
> **本次**:第一步,零风险纯 prompt —— repair 摘要检测到"文件不存在"失败时,追加一条产物名一致性诊断提示。
> **基线**:`npm test` 496 pass / 0 fail。
> **状态**:已实现 + 单测覆盖,已 commit 推送。

---

## 改动

`extensions/task/task.ts` 的 `formatRepairSummary`(repair 时喂给 LLM 的失败摘要):

- 新增 `looksLikeMissingArtifact(failures)` 纯判定:失败断言含 `ENOENT / not found / 不存在 / 找不到 / no such file` 时返回 true。
- `formatRepairSummary` 在"失败断言"段后,命中时追加一条定向提示:
  > ⚠️ 这次失败像是「文件不存在」。先别急着放宽 verify 或改执行方法,优先核对三处产物名是否一致:contract.artifacts[].name、skill.md 里写出的文件名、verify.mjs 里 stat/读取的路径。最常见的死循环就是三者名字写岔了。

**为什么这么小**:这是 artifact-name 报告 P2 项(repair 诊断提示),零流程改动、零风险,直接命中用户那次痛点。报告里更重的项(P1 save 前机器一致性检查)涉及"怎么可靠提取 verify 脚本里的文件名",需谨慎设计,留待单独评估。

## 测试

`tests/task-extension.test.ts`:
- `looksLikeMissingArtifact flags missing-file failures and stays quiet otherwise` —— 命中 ENOENT/不存在/找不到,正常失败(内容错误、exit 1)不误报。
- 现有 `/task run failure offers optional taskbook repair`(failures 是 `{assertion:'link'}`)仍绿,佐证正常失败路径不被误触发。

## 后续(报告剩余项,本次未做)

| 报告项 | 评估 |
|---|---|
| **P1 save 前一致性检查** | 该做,但要解决"verify 是任意 JS,机器提取文件名不可靠"的问题。倾向反向方案:让 worker/verify 从 contract 读名字而非硬编码。需设计。 |
| §2 review 再加确认环节 | 砍:已有 VERIFY DESIGN GATE 覆盖,重复。 |
| §5 `/task show` 加一致性摘要 | 砍(YAGNI):P1 做了源头拦截,landed 的就是好的,show 不需要再看。 |
