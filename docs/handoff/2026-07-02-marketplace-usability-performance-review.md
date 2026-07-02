# UGK Task Marketplace 可用性与流畅度测试记录

日期: 2026-07-02

目标站点: `https://ugk-task-share.pages.dev/`

## 测试范围

- 桌面视口: `1365x768`
- 移动视口: iPhone `390x844 DPR=3`
- 页面: 首页、上传、账户、管理、GitHub 登录跳转
- 交互: 搜索、分类、排序、语言、主题、复制安装命令、未登录喜欢/收藏、上传禁用态
- 工具: Chrome DevTools、Lighthouse、HTTP 端点抽样、独立子 agent 黑盒测试

## 结论

生产站没有发现 JS error 或明显交互卡顿。主要问题是移动端市场页隐藏了分类筛选和排序控件。其余是低成本 SEO/a11y 和静态资源 fallback 问题。

## 已修复

1. 移动端显示分类和排序控件。
   - `styles.css` 不再在 `max-width: 720px` 隐藏 `select.search`。
   - 移动端 select 改为 `width: 100%`。

2. 表单控件补基础属性。
   - 首页搜索、分类、排序补 `name`。
   - 语言选择器补 `name="language"`。

3. 补基础 SEO 和 landmark。
   - 首页、上传、账户、管理、CLI auth 页补 `meta description`。
   - 主内容容器从 `div.shell` 改为 `main.shell`。
   - 页面补 `favicon` link。

4. 修静态 crawler/resource fallback。
   - 新增 `robots.txt`。
   - 新增 `llms.txt`。
   - 新增最小 `favicon.ico`，避免 `/favicon.ico` 返回首页 HTML。

5. 补轻量 a11y polish。
   - 提高暗色弱文本对比。
   - stats 更新时同步 like/save 按钮 `aria-label`。
   - theme toggle 的可见模式文字标为 `aria-hidden`，避免 visible label 和 accessible name 不一致。

## 暂不处理

- N+1 stats 请求: 当前 7 个任务下搜索/排序交互在毫秒级，没有卡顿证据。等任务量增长或复测显示网络成为瓶颈，再把 stats 合并进 manifest 或批量接口。
- CSS/JS minify/hash: 当前体积小，不引入构建链。
- 虚拟滚动: 当前任务量不需要。

## 验证

- `node --test tests/task-share-i18n.test.ts`
- `node --test tests/task-marketplace-functions.test.ts`
- `git diff --check`
- 本地静态服务移动端复核: 搜索、分类、排序控件均可见，无横向溢出。
