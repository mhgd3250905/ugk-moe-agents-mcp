# UGK Task Marketplace — 前端 UI 优化交接手册

> **对象**:负责优化 marketplace 前端 UI 的同事
> **日期**:2026-07-01
> **生产站点**:https://ugk-task-share.pages.dev
> **目标**:在现有功能基础上提升视觉品质和交互体验

---

## 1. 你要改什么

UGK task 分享市场的前端,共 **4 个 HTML 页面**,纯静态(无框架、无构建步骤):

```
docs/task-share/
├── index.html        ← 主页(298 行,含 task 卡片列表 + 搜索 + 统计)
├── upload/index.html ← 上传 task 页(159 行,表单)
├── account/index.html← 用户账户页(94 行,收藏/下载/提交记录)
└── admin/index.html  ← 管理审核页(97 行,审核提交 + 举报)
```

**技术栈**:纯 HTML + CSS + 原生 JS。每个文件自包含(`<style>` + `<script>` 内联),零依赖、零构建。Cloudflare Pages 直接部署 `docs/task-share/` 目录。

**你只需要改这 4 个文件**,不碰后端(`functions/`)、不碰 CLI(`bin/`)。

---

## 2. 快速上手(5 分钟)

### 环境准备
```bash
git clone <repo>
cd ugk-core
npm install        # 装依赖(主要为了跑测试)
npm test           # 确认 519/519 pass(前端改动不应影响后端测试)
```

### 本地预览(不用部署也能看效果)
直接浏览器打开 HTML 文件:
```
file:///E:/AII/ugk-core/docs/task-share/index.html
```
数据会从生产 API(`https://ugk-task-share.pages.dev/api/*`)拉取,所以能看到真实 task。**但 CORS 可能拦截**——更可靠的方式:

### 本地起服务预览
```bash
cd docs/task-share
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```
这样 fetch `/api/*` 会打到 localhost(没有 Functions,API 会 404,但能看到空状态 UI)。**看纯视觉够用,看功能交互需要部署到 Cloudflare**。

### 部署预览(最可靠)
```bash
# 需要 Cloudflare API token(找项目负责人要)
export CLOUDFLARE_API_TOKEN="<token>"
npx wrangler pages deploy docs/task-share --project-name ugk-task-share --commit-dirty=true
# 输出一个 preview URL,功能和生产一致
```

> 每次部署生成独立 preview URL,不影响生产,可以放心反复部署看效果。

---

## 3. 视觉系统现状(改样式的入口)

### 配色(CSS 变量,每个 HTML 的 `:root`)
```css
:root {
  --bg: #0a0a0f;              /* 页面深色底 */
  --bg-elev: #14141c;         /* 卡片底 */
  --bg-elev2: #1c1c28;        /* 卡片悬浮底 */
  --border: #2a2a3a;          /* 边框 */
  --border-light: #3a3a4a;    /* 悬浮边框 */
  --text: #e4e4e7;            /* 主文字 */
  --text-muted: #8b8b9a;      /* 次要文字 */
  --text-dim: #5a5a6a;        /* 最暗文字 */
  --accent: #6366f1;          /* 紫蓝主色 */
  --accent2: #8b5cf6;         /* 紫色渐变末端 */
  --accent-grad: linear-gradient(135deg, #6366f1, #8b5cf6);  /* 主按钮/标题渐变 */
  --success: #10b981;
  --danger: #ef4444;
  --radius: 16px;             /* 大圆角(卡片) */
  --radius-sm: 10px;          /* 小圆角(按钮/输入框) */
  --shadow: 0 4px 24px rgba(0,0,0,0.3);
  --shadow-hover: 0 8px 32px rgba(99,102,241,0.15);  /* 卡片悬浮紫光 */
  --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
```

**改全局风格 = 改这些变量**。比如想换成绿色系,改 `--accent` 和 `--accent-grad` 就行。

### ⚠️ CSS 没有共享文件
4 个 HTML **各自内联了一份 `:root` 变量**(内容相同)。改配色要同步改 4 个文件。**建议第一个优化:把 `<style>` 提取成 `docs/task-share/styles.css` 共享文件**,4 个页面 `<link>` 引入。这样改一处生效全局。

### 字体
系统字体栈,无自定义字体引入:
```css
font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```
代码区:`"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace`

---

## 4. 页面结构详解

### index.html(主页,工作量最大)

**布局**:
```
<nav>          固定顶栏(毛玻璃,品牌 + 导航 + 登录)
<hero>         渐变大标题 + 命令框
<stats>        4 格统计(动态数字)
<catalog>      task 卡片网格(auto-fill 340px,响应式 1/2/3 列)
<footer>       底部
```

**task 卡片结构**(JS 动态渲染,见 `taskCardHTML()` 函数):
```
<article class="task-card">
  <chips>      分类标签 + 作者
  <h2>         task 标题
  <desc>       描述
  <metric-row> 下载/点赞/收藏计数(动态)
  <card-actions>
    <download> <like> <favorite> <copy> <report>  5 个图标按钮
    <command>  安装命令
  </card-actions>
</article>
```

**数据流**:页面加载 → `refreshCatalog()` 从 `/api/manifest` 拉取 → `taskCardHTML()` 渲染 → `bindCards()` 绑定交互 → `refreshStats()` 拉计数更新。

### upload/index.html
表单 4 字段 + zip 上传。表单提交 → `submitUpload()` → POST `/api/tasks/submit`。

### account/index.html
登录后显示收藏/下载/提交记录。`refreshAccount()` 拉三个 API 渲染。

### admin/index.html
审核队列。Publish/Reject 按钮 → POST `/api/admin/submissions/<id>` → `refreshAdmin()`。

---

## 5. JS 功能契约(改 UI 时别破坏这些)

JS 用 `data-attribute` 做交互绑定,**改 HTML 结构时必须保留这些属性**,否则功能失效:

### 必须保留的 data-attribute
| 属性 | 作用 | 在哪 |
|---|---|---|
| `data-catalog` | task 列表容器,JS 渲染卡片到这里 | index |
| `data-task-card` | task 卡片标识,搜索/排序/过滤靠它 | index(JS 生成) |
| `data-task="<name>"` | task 名,点赞/收藏/举报/下载用 | index(JS 生成) |
| `data-action="like\|favorite\|report"` | 交互动作,`postAction()` 识别 | index(JS 生成) |
| `data-api="<url>"` | 交互的 API 端点 | index(JS 生成) |
| `data-copy="<命令>"` | 复制到剪贴板的内容 | index(JS 生成) |
| `data-count="<name>:<key>"` | 动态计数更新锚点 | index(JS 生成) |
| `data-search` `data-sort` `data-category-filter` | 搜索/排序/过滤控件 | index |
| `data-marketplace-stat="<key>"` | 全局统计数字锚点 | index |
| `data-user` | 显示 `@login` 或 `Guest` | 全部 4 页 |
| `data-upload-form` `data-upload-result` | 上传表单 + 结果显示 | upload |
| `data-account-page` | 账户内容容器 | account |
| `data-admin-page` | 管理内容容器 | admin |
| `data-review-id` `data-review-status` | 审核按钮(Publish/Reject) | admin(JS 生成) |

### 必须保留的 JS 函数(改样式可以,别删功能逻辑)
- `taskCardHTML(t)` — task 卡片 HTML 模板(**改卡片视觉 = 改这里**)
- `refreshCatalog()` — 从 manifest 拉数据 + 渲染 + 绑定
- `bindCards()` — 给动态生成的卡片绑事件
- `filterTasks()` — 搜索/排序/过滤
- `postAction()` — 点赞/收藏/举报
- `applyTaskData()` — 更新计数

> **改卡片 UI 的正确方式**:只改 `taskCardHTML()` 里的 HTML 结构和 CSS class,保留所有 `data-*` 属性。CSS 在 `<style>` 里改。

---

## 6. 可优化方向(建议,不是硬要求)

按性价比排序:

### 高价值
1. **提取共享 CSS** — 4 个 `:root` 重复,提取成 `styles.css`,4 页 `<link>` 引入。后续改样式 4 倍提效。
2. **task 卡片信息层级优化** — 当前卡片信息较密(标签+标题+描述+3 计数+5 按钮+命令行),可以精简或分组。
3. **空状态设计** — 当前空状态只有一句灰字 "No tasks published yet",可以做得更友好(插画/引导)。
4. **加载状态** — 当前卡片是突然出现的,加 skeleton/骨架屏过渡更顺滑。

### 中价值
5. **搜索/过滤 UX** — 当前是三个并排控件,可以改成更现代的(搜索框带图标、分类用 chips 切换)。
6. **卡片悬浮微动效** — 已有 `translateY(-2px)`,可以加更细腻的(渐变光晕、图标缩放)。
7. **上传表单体验** — zip 拖拽区(目前是普通 file input)、上传进度、校验提示。
8. **深色/浅色切换** — 目前只有深色,加个切换开关。

### 低价值(慎做)
9. **加字体** — 当前系统字体够用,引入自定义字体增加加载时间。
10. **加框架** — 当前纯 HTML+JS 才 648 行,引入 React/Vue 是过度工程化。

---

## 7. 后端 API 速查(前端调用)

所有 API 在 `https://ugk-task-share.pages.dev/api/*`,前端用相对路径 `fetch('/api/...')` 调用:

| 方法 | 端点 | 作用 | 需登录 |
|---|---|---|---|
| GET | `/api/manifest` | task 列表(CLI + 主页用) | ❌ |
| GET | `/api/stats` | 全局统计 | ❌ |
| GET | `/api/session` | 当前登录用户 | ❌ |
| GET | `/api/tasks/<name>/stats` | 单 task 计数 + 当前用户标记 | ❌ |
| GET | `/api/community/tasks` | 已发布 task(备用) | ❌ |
| POST | `/api/tasks/<name>/like` | 点赞/取消 | ✅ |
| POST | `/api/tasks/<name>/favorite` | 收藏/取消 | ✅ |
| POST | `/api/tasks/<name>/report` | 举报(JSON body) | ✅ |
| POST | `/api/tasks/<name>/download` | 记录下载 | ❌ |
| POST | `/api/tasks/submit` | 上传 task(FormData) | ✅ |
| GET | `/api/account/favorites` | 我的收藏 | ✅ |
| GET | `/api/account/submissions` | 我的提交 | ✅ |
| GET | `/api/account/downloads` | 我的下载 | ✅ |
| GET | `/api/admin/submissions` | 审核队列 | ✅ admin |
| GET | `/api/admin/reports` | 举报队列 | ✅ admin |
| POST | `/api/admin/submissions/<id>` | 审核(JSON `{status}`) | ✅ admin |
| GET | `/api/auth/github` | GitHub 登录(302 跳转) | — |

> 前端改 UI 不需要动这些 API。了解返回结构有助于设计展示,可以用浏览器直接访问 GET 端点看 JSON。

---

## 8. 部署方式

```bash
# 1. 本地测试不影响(前端改动不影响后端测试)
npm test

# 2. 部署 preview(需要 token,找项目负责人要)
export CLOUDFLARE_API_TOKEN="<token>"
npx wrangler pages deploy docs/task-share --project-name ugk-task-share --commit-dirty=true

# 3. 会输出 preview URL,给项目负责人 review
# 4. review 通过后合 PR,自动部署到生产
```

**部署配置**(`wrangler.toml`):
- `pages_build_output_dir = "docs/task-share"` — 部署这个目录
- Pages 会自动发现项目根的 `functions/` 目录并部署为 Functions(后端)
- **你只改 `docs/task-share/*.html`,不动 `functions/`**

---

## 9. 约定

- **纯 HTML+CSS+JS,不引入框架**(4 个文件 648 行,框架是杀鸡用牛刀)
- **保留所有 `data-*` 属性**(功能绑定靠它们)
- **保留 JS 函数签名**(可以改实现,别删函数)
- **4 个页面视觉统一**(同一套 CSS 变量、同一套组件样式)
- **响应式必须有**(已有 `@media` 断点 768px/600px/480px)
- **改动提交前跑 `npm test`**(确保没破坏后端测试)

---

## 10. 参考资料

| 文档 | 内容 |
|---|---|
| 本文档 | 前端 UI 优化交接 |
| `docs/handoff/2026-07-01-marketplace-r2-direct-and-frontend-rewrite.md` | 完整架构 + 部署踩坑记录 |
| `docs/design/2026-07-01-task-marketplace-r2-direct-storage.md` | R2 直存设计文档 |
| `AGENTS.md` | 项目运行时上下文 |
| `docs/DEVELOPMENT.md` | 开发侧约定 |

---

> 有问题找项目负责人。改之前先本地预览确认基线,改之后部署 preview 给 review。
