# Task 产物名不一致问题复盘

## 结论

本次 task 多轮修不好，直接原因是执行产物名和 verify 检查产物名不一致。

这不是单纯的 agent 能力问题。agent 确实没有把名字统一好，但机制也给了它犯错空间:taskbook 里有三处都在描述产物，却没有一个强制的单一真相。

- `skill.md`:告诉 worker 应该生成什么文件。
- `contract.json`:声明最终产物契约。
- `verify.mjs`:实际检查什么文件是否存在、内容是否正确。

当前系统能在 verify 阶段发现“文件不存在”，但不能提前判断“skill / contract / verify 的产物名不一致”。所以 agent 会反复围绕“文件不存在”这个症状改，而不是回到根因:统一产物名。

## 复盘判断

这类问题的根因是产物名没有被机制收敛。

理想状态应该是:

- 先确定最终产物名。
- worker 只按这个名字写文件。
- contract 只声明这个名字。
- verify 只检查这个名字。

现在的问题是这三步分散在自然语言、JSON、JS 脚本里，reviewer 很容易在某一处写成另一个名字。只要名字不一致，后续无论怎么重跑都会失败。

## 机制优化方向

### 1. 以 `contract.artifacts[].name` 作为唯一权威产物名

后续机制应明确规定:产物名以 `contract.json` 为准。

`skill.md` 和 `verify.mjs` 只能围绕 `contract.artifacts[].name` 展开，不能自由引入另一个产物文件名。

如果 reviewer 想改产物名，必须同步修改三处:

- `contract.artifacts[].name`
- `skill.md` 的输出说明
- `verify.mjs` 的检查路径

### 2. review 阶段先确认“最终产物名表”

review/update/repair 阶段在输出完整 taskbook JSON 前，应先要求 reviewer 用 questionnaire 确认最终产物名表。

建议确认项:

- 最终要生成哪些文件。
- 每个文件的精确文件名。
- 每个文件由 worker 哪一步生成。
- verify 会检查哪些文件。
- 是否存在旧文件名、临时文件名、描述名混入。

这一步的价值是把“名字”从散落文本里提前拎出来，让用户和 reviewer 先对齐。

### 3. save 前增加产物名一致性检查

保存 taskbook 前，机器应做一次轻量一致性检查。

检查对象:

- `contract.artifacts[].name`
- `skill.md` 中明确提到的输出文件名
- `verify.mjs` 中读取、stat、检查的输出文件名

如果发现明显不一致，拒绝 landed，并给出定向反馈。

示例:

```text
产物名不一致，拒绝 landed:

contract 声明:
- linux_do_post.json

skill 提到:
- linux_post.json

verify 检查:
- linux_do_post.json

请统一 skill / contract / verify 的产物名后重新输出 taskbook JSON。
```

这里不需要做复杂 JS 静态分析。先用保守规则提取明显文件名即可；不确定时打回人工确认。

### 4. repair 阶段优先诊断文件名不一致

当 verify failure 是“某文件不存在”时，repair prompt 应自动追加提示:

- 先检查是否是产物名不一致。
- 对照 worker summary 里实际生成的文件名。
- 对照 outputDir 实际文件列表。
- 不要先放宽 verify，先统一产物契约。

这样可以避免 agent 误把问题理解成“verify 太严”或“CDP 没跑通”。

### 5. `/task show` 导览增加产物名一致性摘要

`/task show` 的导览里可以新增一项:

- 产物名一致性:contract / skill / verify 是否一致。

这样用户不用展开完整 `skill.md`、`contract.json`、`verify.mjs`，也能一眼看出 taskbook 是否存在名字漂移。

## 推荐优先级

P0:增强 review prompt，要求先确认最终产物名表。

P1:save 前加产物名一致性检查，阻止坏 taskbook landed。

P2:repair prompt 针对“文件不存在”类失败补充产物名诊断。

P3:`/task show` 导览里增加“产物名一致性”摘要。

## 验收标准

- contract 声明 A、verify 检查 B 时，保存前拒绝 landed。
- skill 要求生成 A、contract 声明 B 时，保存前拒绝 landed。
- verify 文件不存在时，repair 明确提示检查产物名一致性。
- 多产物 taskbook 仍可正常保存，只要三处产物名集合一致。
- 正常 taskbook 不受影响。

## 一句话

不要让 agent 在三份文本里分别记产物名。产物名必须有单一真相，保存前必须机器检查。
