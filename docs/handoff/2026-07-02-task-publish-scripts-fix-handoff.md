# task publish 漏传 scripts/ 修复 + 三件套落地交接

> **日期**:2026-07-02
> **性质**:修复 + 远端实测验证通过,文档同步
> **涉及 PR**:#30(边界清理)/ #31(task update/remove)/ #32(publish scripts 修复)
> **读者**:接手 ugk task 系统的同事
> **一句话**:用户反馈 `ugk task install` 后 task 缺 `scripts/` 目录,定位为 publish 端硬编码只打 5 文件、主动丢弃 scripts/,已修复并经三层验证(单测 + 本地真实数据 + 远端发布重装)。

---

## 1. 问题怎么发现的

用户 `ugk task install subtitle-fluent-translator` 后,发现下载的 task 缺 `scripts/` 目录,但本机源 task 有该目录(含 `make-fluent-subtitle.mjs` + `.test.mjs`)。skill.md 里 `node "$TASK_DIR/scripts/make-fluent-subtitle.mjs"` 引用的脚本不存在,task 运行必崩。

## 2. 根因(第一性)

`extensions/task/task-share-publish.ts` 的 `buildTaskZip` **硬编码只打 5 个核心文件**(`taskbook/spec/contract/skill/verify`),`scripts/` 子目录被一句"YAGNI,文档 §2 决策⑥"主动丢弃。

整条链路是被动接收,没有一端校验:
```
buildTaskZip 硬编码 5 文件(不扫目录)
  → zip 不含 scripts/
    → submitTask unzip 出的 files 不含 scripts/
      → R2 不含、file_list 不含
        → manifest 不含
          → install 只下 manifest 里的 → 缺 scripts/(用户端才暴露)
```

**失败暴露在离根因最远的用户端** —— 这是最坏的失败延迟。

## 3. 三个缺陷一起修(PR #32)

| 缺陷 | 性质 | 修法 |
|---|---|---|
| **1 publish 漏传 scripts/** | 直接根因,功能 bug | `buildTaskZip` 改 async,扫 `loaded.dir` 打包全部文件;新增 `collectExtraFiles`(递归 readdir,排除 `*.test.mjs` + 垃圾);目录不存在时降级只打核心 5 文件 |
| **2 链路无引用校验** | 防回归保险 | 本地:`extractScriptReferences` + `assertReferencedFilesExist`,publish 前校验 skill.md/verify.mjs 引用的脚本都在包里;服务端:`submitTask` 兜底校验(纯 JS 复制版,Workers 不能 import TS),坏包返回 `missing_referenced_file` 400 + R2 零写入 |
| **3 命名认知陷阱** | 非 bug,但误导 | `REQUIRED_FILES` 两处加注释:此清单是"最小必需校验集",不是打包全集(正是这个命名让作者误把"5 个必需"当"打包全部"而丢了 scripts/) |

**关键设计**:
- `buildTaskZip` 变 async(扫目录要 await),调用方 `publishTask` 已 async,无破坏
- 排除规则极简:实测所有 task 测试文件统一是 `*.test.mjs`,只排这一个后缀 + `.log` + `.DS_Store`
- TS/JS 双份 `extractScriptReferences`:本地 TS 版 + 服务端纯 JS 复制版,按 marketplace.js 现有约定注释交叉引用

## 4. 同期落地的另外两个 PR

### PR #30:边界清理(对抗式审查产出)
- `.npmignore` 排除 functions/migrations/wrangler/scripts(CLI 包不该带半个 Cloudflare 项目,实测少 39 文件)
- `smoke:tui` → `smoke:rpc`(node-pty 未声明依赖,原 smoke:tui 名实不符)
- 删 `extensions/shared/driver-view.ts` 死代码 + smoke 残留断言
- README 删"投屏"(已下线能力);AGENTS 补 `/task publish`、`/subagent`、`/todos`;测试口径改为环境稳定描述

### PR #31:task update / remove 命令(用户痛点驱动)
- 根因:`bin/ugk.js` dispatch 只拦 `task install`,`remove`/`update` 不是 CLI 命令,被透传进 TUI 由 agent 手动操作,卡确认/超时
- 加 `task remove`(默认确认,`-y` 跳过)+ `task update`(非交互覆盖,走 install force 路径)
- install 加内部 `force` 参数(只 update 用,对外 install 不暴露)

## 5. 三层验证(全部通过)

| 层 | 方法 | 结果 |
|---|---|---|
| 第一层 单测 | `npm test` / `npm run test:integration` | ✅ 568 pass / 0 fail;integration 36/36 |
| 第二层 本地真实数据 | 真实 subtitle task 目录调 `buildTaskZip` 解压 | ✅ zip 含 `scripts/make-fluent-subtitle.mjs`,排除 `.test.mjs`,引用校验 PASS |
| 第三层 远端发布重装 | 线上 publish v1.0.2 → 审核通过 → 删本地 → `ugk task install` | ✅ **install 后 `scripts/make-fluent-subtitle.mjs` 完整下到本地(14297 字节,与源一致)** |

**远端实测由用户在升级到最新版后操作,确认通过。**

## 6. 验证命令(下次复用)

```bash
# 单测
npm test && npm run test:integration

# 本地真实数据验真(只读,不发布)
node --input-type=module --eval '
import { loadTaskbook } from "./extensions/task/task-book.ts";
import { buildTaskZip, collectExtraFiles } from "./extensions/task/task-share-publish.ts";
import { unzipSync } from "fflate";
const loaded = await loadTaskbook(process.cwd(), "<task-name>");
const zip = await buildTaskZip(loaded);
console.log(Object.keys(unzipSync(zip)));
'

# 端到端(改线上,需 marketplace 权限)
ugk task remove <name> -y
ugk task install <name>
ls ~/.pi/agent/tasks/<name>/scripts/
```

## 7. 发现的体验缺陷(未修,记录待定)

用户实测时发现:`/task publish` 一路回车会用默认标题(name)+ 默认描述(taskbook.description)提交,容易误发重复 submission。非 bug,是体验问题。若要改:标题/描述用默认值时给二次确认,或版本号重复更早提示。**本次未修,留待决策。**

## 8. 相关文件索引

| 文件 | 作用 |
|---|---|
| `extensions/task/task-share-publish.ts` | publish 打包 + 引用校验(本次主改) |
| `functions/_lib/marketplace.js` | 服务端 submitTask 兜底引用校验 + REQUIRED_FILES 注释 |
| `bin/task-install.js` | install/remove/update CLI + REQUIRED_FILES 注释 |
| `bin/ugk.js` | dispatch(task install/remove/update 拦截) |
| `tests/task-share-publish.test.ts` | 本地端测试(13→20) |
| `tests/task-marketplace-functions.test.ts` | 服务端测试(补 missing_referenced_file) |
| `docs/handoff/2026-07-02-x-search-json-truncation-diagnosis.md` | 同日另一诊断(x-search 截断,未改代码) |

## 9. 状态收尾

- **代码**:三个 PR(#30/#31/#32)全部合并进 main,HEAD `0ace0be`,与 origin/main 同步
- **远端实测**:用户在升级最新版后验证通过(install 下到完整 scripts/)
- **线上 task**:subtitle-fluent-translator v1.0.2 已发布,manifest 含 `scripts/make-fluent-subtitle.mjs`;旧 v1.0.0/v1.0.1 仍是坏的(用户可忽略,latest 已指向 1.0.2)
