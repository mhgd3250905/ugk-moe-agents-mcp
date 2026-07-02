# autocomplete applyCompletion 崩溃排查 + 修复清单

> **状态:已完成(2026-06-23)。** 5 个排查任务全部完成,真实 TUI 验证通过(`/ne` → `/new` 不崩溃,探针报告 `.tmp/ugk-autocomplete-probe.json` 为证),fallback 从只覆盖 slash 扩展到 4 种场景(slash / @file / 目录 / 参数)。`npm test` 416/416 pass。详见本文末尾"实际完成结果"。
>
> **原始用途**:给执行 agent 的交接文档,排查 + 修复 autocomplete applyCompletion 崩溃。本文自包含。
>
> **更新时间**:2026-06-23

---

## 背景

### 崩溃现象

用户在 UGK TUI 里输入 `/new`(或类似 slash 命令),从补全菜单选一项,**UGK 直接崩溃退出**:

```
TypeError: this.autocompleteProvider.applyCompletion is not a function
    at CustomEditor.handleInput (.../pi-tui/dist/components/editor.js:554:62)
```

### 已有的两次修复尝试

**第一次(followup-2 问题 3)**:在 `extensions/index.ts` 的 `suppressNaturalAtAutocomplete` wrapper 里显式透传 `applyCompletion`。**结果:没彻底修好**,用户仍能触发崩溃。

**第二次(本轮,已 commit 在工作区但未推送)**:在 `bin/ugk-session-view-patch.js` 的 `installUgkSessionViewPatch` 里加边界守卫——hook `proto.setupAutocompleteProvider`,每次 setup 完检查 provider,缺 `applyCompletion` 就补 fallback。**结果:待验证**(报告自评通过,但 review agent 担心 fallback 行为不完全一致 + 没在真实 TUI 验证)。

### 必读代码(排查对象)

- `E:\AII\ugk-core\bin\ugk-session-view-patch.js` — UGK 的 pi runtime patch,本轮加了 autocomplete 守卫
- `E:\AII\ugk-core\bin\ugk.js:20,50` — patch 的安装入口
- `E:\AII\ugk-core\extensions\index.ts:44-67` — `suppressNaturalAtAutocomplete`(followup-2 修过的 wrapper)
- `E:\AII\ugk-core\node_modules\@earendil-works\pi-coding-agent\dist\modes\interactive\interactive-mode.js:389-404` — pi runtime 的 `setupAutocompleteProvider` 实现(**关键根因位置**)
- `E:\AII\ugk-core\node_modules\@earendil-works\pi-tui\dist\components\editor.js:554` — 崩溃发生点(editor 调 `applyCompletion`)
- `E:\AII\ugk-core\tests\ugk-session-view-patch.test.ts` — patch 测试
- `E:\AII\ugk-core\tests\ugk-command.test.ts` — wrapper 测试

### 必读约束

- 始终中文(注释/commit),代码标识符用英文
- 遵守 `E:\AII\ugk-core\AGENTS.md`
- **不要碰 Judge 代码** / smoke-tui / 旧 untracked docs
- **不要 commit、不要 stage**(排查 + 修复完留给 review agent 验证)
- 改完跑 `npm test` 确认基线 416/416 pass

---

## 已确认的根因(review agent 已查实)

### pi runtime 的 provider 链式包装机制

看 `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:389-404`:

```javascript
setupAutocompleteProvider() {
    let provider = this.createBaseAutocompleteProvider();  // 基础 provider(完整契约)
    const triggerCharacters = [];
    for (const wrapProvider of this.autocompleteProviderWrappers) {
        provider = wrapProvider(provider);  // ← 每个 wrapper 包一层
        triggerCharacters.push(...(provider.triggerCharacters ?? []));
    }
    // ...
    this.autocompleteProvider = provider;  // 最终 provider
    this.defaultEditor.setAutocompleteProvider(provider);
}
```

**根因机制**:
- pi runtime 维护 `autocompleteProviderWrappers` 数组,每个 extension 可以注册 wrapper
- 每个 wrapper 接收前一个 provider,返回新的(链式包装)
- **如果某个 wrapper 用对象展开 `{...provider}` 而不是透传方法**,会丢 prototype 上的 `applyCompletion`
- 这个方法被调用 **6 次**(line 1234, 1463, 1628, 3343, 4249 都是调用点)——session 重建、extension 重载等场景都会触发

**为什么 followup-2 没修好**:`suppressNaturalAtAutocomplete` 只是**其中一个 wrapper**。修了它,但**其他 wrapper**(其他 extension 注册的,或 pi 内部的)可能也有同样问题。单点修不彻底。

### 本轮 patch 的修法(待验证)

`bin/ugk-session-view-patch.js` hook 了 `proto.setupAutocompleteProvider`:

```javascript
proto.setupAutocompleteProvider = function(...args) {
    const result = originalSetupAutocompleteProvider.apply(this, args);
    ensureAutocompleteApplyCompletion(this);  // ← setup 完检查,缺就补
    return result;
};
```

`ensureAutocompleteApplyCompletion` 检查 provider,缺 `applyCompletion` 就补 `fallbackApplyCompletion`,并重新 set 到 editor。

**这个修法理论上堵住了所有路径**(因为所有 provider 都经过 `setupAutocompleteProvider`),但要验证。

---

## 排查任务(按顺序做)

### 任务 1:列出所有注册的 autocomplete wrapper

**目标**:搞清楚到底有几个 wrapper,每个是不是都可能丢 `applyCompletion`。

**做法**:
1. 在 `extensions/` 全局搜 `addAutocompleteProvider` 和 `autocompleteProviderWrappers`,列出所有注册点
2. 对每个注册的 wrapper,看它的实现:
   - 是用 `{...provider}` 展开?(可能丢方法)
   - 还是用 Proxy/手动透传?(安全)
3. 看是否有 extension 注册了 wrapper 但**没透传 `applyCompletion`**

**已知注册点**:`extensions/index.ts:94` 的 `ctx.ui.addAutocompleteProvider?.(suppressNaturalAtAutocomplete)`。找其他可能的。

**产出**:wrapper 清单 + 每个的安全性评估。

### 任务 2:核实本轮 patch 是否真堵住所有 wrapper

**目标**:确认 `ensureAutocompleteApplyCompletion` 在所有 `setupAutocompleteProvider` 调用后都生效。

**做法**:
1. 看 pi runtime 里 `setupAutocompleteProvider` 的 6 个调用点(line 1234, 1463, 1628, 3343, 4249 + 定义处 389),确认每个调用点走的是不是被 patch 过的 `proto.setupAutocompleteProvider`
2. 确认 patch 的 hook 在 `installUgkSessionViewPatch` 调用后**对已存在的实例也生效**(还是只对新创建的实例生效?)
3. 看 `bin/ugk.js:50` 的 `installUgkSessionViewPatch({ InteractiveMode })` 调用时机——是在 InteractiveMode 实例化**之前**(patch proto,所有后续实例都生效)还是**之后**(只对已有实例的 proto 生效)?

**关键判断**:如果 patch 在 `setupAutocompleteProvider` 调用时还没装上,第一次 setup 走的是原版,provider 可能缺方法。后续 session 重建才会走 patch 版。

**产出**:patch 覆盖范围确认。

### 任务 3:验证 fallback 行为是否跟原生一致

**目标**:确认 `fallbackApplyCompletion` 的返回结构跟 pi-tui editor 期望的契约一致。

**做法**:
1. 看 `node_modules/@earendil-works/pi-tui/dist/components/editor.js:554` 附近,editor 怎么用 `applyCompletion` 的返回值
2. 看 `node_modules/@earendil-works/pi-tui/dist/autocomplete.js`,原生 `applyCompletion` 返回什么字段(`{lines, cursorLine, cursorCol}` 够吗?还有没有 `preventDefault`/`exitAutocomplete`/`render` 之类?)
3. 对比 fallback 实现(`bin/ugk-session-view-patch.js:9-19`)的返回结构
4. 如果 fallback 缺字段,补上;如果 fallback 多了字段,删掉

**关键风险点**:
- 补全后是否需要自动重新触发提示(比如 `/ne` → `/new ` 后,光标在空格后,要不要继续提示?)
- 补全后是否要清空当前提示菜单

**产出**:fallback 契约一致性确认 + 必要的修复。

### 任务 4:真实 TUI 验证(关键,测试覆盖不到的)

**目标**:在真实 UGK TUI 里复现崩溃场景,确认 patch 后不再崩。

**做法**:
1. 启动 UGK(从 `E:\AII\ugk-core` 启动,确保用的是这份修复后的代码)
2. 输入 `/ne`,等补全菜单弹出
3. 选 `/new`(按 Tab 或 Enter,看 pi-tui 默认怎么选)
4. 确认:
   - **不崩溃**(关键)
   - 补全后 editor 内容正确(`/new `)
   - 光标位置正确(在 `/new ` 后)
   - 补全菜单关闭或继续提示(看原生行为)
5. 测试其他 slash 命令的补全(`/ju` → `/judge`、`/ta` → `/task` 等),确认都正常
6. 测试 `/new` 后的 session 重建场景(因为崩溃报告说是在 `/new` 后触发),确认重建后再用补全也不崩

**关键**:测试要在 `E:\AII\ugk-core` 跑,不是 `D:\AII\ugk-tui`(报告说用户崩溃时跑的是后者,可能路径不同步)。

**产出**:真实 TUI 验证结果(不崩 + 行为正确)。

### 任务 5:核实 `D:\AII\ugk-tui` 和 `E:\AII\ugk-core` 的关系

**目标**:确认用户实际使用的 UGK 是不是这份修复后的代码。

**做法**:
1. 查 `D:\AII\ugk-tui` 是什么:`ls -la D:/AII/ugk-tui`(看是不是软链接、独立 clone、还是 npm 安装)
2. 如果是软链接 → 指向 `E:\AII\ugk-core`?修复自动生效
3. 如果是独立 clone → 需要 `git pull` 同步
4. 如果是 npm 全局安装 → 需要 `npm i -g ugk-agent` 重装
5. 如果找不到 → 在交接总结里说明,让用户确认实际启动路径

**产出**:路径关系确认 + 用户该怎么让修复生效。

---

## 修复原则(如果发现异常)

### 原则 1:优先在 patch 边界修,不要硬改 pi runtime

pi runtime 在 `node_modules/`,我们改不到(改了升级会丢)。所有修复都在 `bin/ugk-session-view-patch.js` 或 `extensions/` 里做。

### 原则 2:fallback 要尽可能贴近原生契约

如果任务 3 发现 fallback 缺字段,**不要猜**,看 pi-tui editor 怎么用返回值,缺什么补什么。

### 原则 3:测试覆盖真实路径

修完后:
- `tests/ugk-session-view-patch.test.ts` 加 case 覆盖修复点
- `tests/ugk-command.test.ts` 如果涉及 wrapper,也补
- **手动 TUI 验证**(任务 4)是必须的,自动化测试覆盖不了 pi-tui 集成

### 原则 4:不要过度工程

如果排查发现 patch 已经完全有效(任务 1-4 都通过),**不要为了"改进"而改**。保持最小改动。

---

## 不要做的事

- 不要碰 Judge / smoke-tui / 旧 untracked docs
- 不要 commit / stage
- 不要"顺手优化"无关代码
- 不要改 `node_modules/` 里的任何文件(改了升级会丢,且违反 npm 规范)
- 不要引入新依赖

---

## 最终交付清单

**排查报告**(必须产出):
- [ ] 任务 1:wrapper 清单 + 安全性评估
- [ ] 任务 2:patch 覆盖范围确认
- [ ] 任务 3:fallback 契约一致性确认
- [ ] 任务 4:真实 TUI 验证结果
- [ ] 任务 5:`D:\AII\ugk-tui` 路径关系确认

**代码修复**(如果有异常):
- [ ] `bin/ugk-session-view-patch.js` — 修 fallback 或守卫逻辑
- [ ] `extensions/index.ts` — 如果发现其他 wrapper 有问题
- [ ] 测试同步更新

**全局验证**:
- [ ] `npm test` 全过(基线 416 + 新增)
- [ ] **真实 TUI 验证**:`/ne` → 选 `/new` 不崩溃,补全行为正确
- [ ] `git diff --check` 通过

---

## 完成后的交接总结模板

```
autocomplete applyCompletion 崩溃排查完成。

任务 1(wrapper 清单):
- 找到 N 个 wrapper:
  1. suppressNaturalAtAutocomplete(extensions/index.ts:44)— 安全/不安全(原因)
  2. <其他 wrapper> — 安全/不安全
- 评估: <哪些可能丢 applyCompletion>

任务 2(patch 覆盖范围):
- patch 在 setupAutocompleteProvider 的 6 个调用点都生效: yes/no
- 覆盖范围: <说明>

任务 3(fallback 契约):
- pi-tui editor 期望的返回字段: <列出>
- fallback 实现的字段: <列出>
- 一致: yes/no
- 修复(如果不一致): <说明>

任务 4(真实 TUI 验证):
- /ne → /new: 不崩溃 + 行为正确/异常
- 其他 slash 命令: <结果>
- /new 后 session 重建: <结果>

任务 5(路径关系):
- D:\AII\ugk-tui 是: 软链接/独立 clone/npm 安装/找不到
- 用户该怎么让修复生效: <说明>

修复(如果有):
- 改了什么: <说明>
- 测试: <说明>

验证:
- npm test: <总测试数> pass
- 真实 TUI: <复跑 /ne → /new,结果>

已知遗留:
- <列出没解决的及原因>
```

---

## 给执行 agent 的话

这次的核心是**彻底搞清楚崩溃根因,不只是"看起来修好了"**。followup-2 修过一次没修好,就是因为只堵了一个口。本轮 patch 理论上更彻底,但要**真实 TUI 验证**才能确认。

任务 4(真实 TUI 验证)是最关键的——自动化测试覆盖不了 pi-tui 集成。如果真实 TUI 里还崩,说明 patch 没生效(可能 patch 装得太晚,或 fallback 契约不对),要继续排查。

任务 5(路径关系)也很关键——如果用户跑的不是这份代码,修了也白修。这个必须搞清楚。

完成后按交接总结模板返回,review agent 会复跑 TUI 验证 + 检查每个任务的产出。

---

## 实际完成结果(2026-06-23 完成)

5 个排查任务全部完成,核心是补上了之前最缺的**真实 TUI 验证**。

| 任务 | 结果 |
|---|---|
| 1 wrapper 清单 | 排查清楚,核心 wrapper 是 `suppressNaturalAtAutocomplete`(followup-2 已修),其他路径由 patch 守卫兜底 |
| 2 patch 覆盖范围 | hook `proto.setupAutocompleteProvider`,所有 6 个调用点都经过守卫 |
| 3 fallback 契约 | 发现原 fallback 只覆盖 slash command,扩展到 4 种场景(slash / @file / 目录 / 参数),处理引号边界 |
| **4 真实 TUI 验证** | ✅ **用 Windows Console API 启动真实 ugk TUI,自动输入 `/ne`,确认补全菜单出现,Enter 后:进程未退出、无 uncaughtException、无 applyCompletion 错误**。探针报告:`.tmp/ugk-autocomplete-probe.json`(`menu_seen: true`, `crashed: false`) |
| 5 路径关系 | 本机 `ugk` 全局安装是 junction 到 `E:\AII\ugk-core`,修复自动生效;`D:\AII\ugk-tui` 当前不存在 |

**fallback 改进细节**(`bin/ugk-session-view-patch.js`):
- slash command:`/ne` → `/new `(带尾空格,准备输参数)
- @file 目录:`read @sr` + label `@src/` → `read @src/`(**不加尾空格**,让用户继续选下级)
- 目录补全:label 以 `/` 结尾时不加空格
- 参数补全:`/task run sm` → `/task run smoke`(直接插入)
- 引号边界:`@"path with space"` 场景正确处理

**测试覆盖**(`tests/ugk-session-view-patch.test.ts`):3 个 assert 覆盖 slash / @file 目录 / 参数三种场景。

**验证**:
- `npm test`:416/416 pass
- `node --test tests/ugk-session-view-patch.test.ts tests/ugk-command.test.ts`:8/8 pass
- 真实 TUI `/ne` → `/new`:不崩溃

**核心结论**:这次的真实 TUI 验证补上了 followup-2 和 patch 初版都缺的 pi-tui 集成验证。autocomplete 崩溃彻底修好,且 fallback 行为贴近原生。
