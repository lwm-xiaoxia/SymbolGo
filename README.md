# SymbolGo

增强前端项目代码跳转能力的 VS Code 扩展。

不自定义快捷键、不自定义 UI、不接管已经能正常工作的跳转，只补齐 VS Code 原生支持不足的前端场景。使用方式就是原生的 **`Ctrl`/`Cmd` + 鼠标左键** 或 **`F12`**。

## 支持的跳转

### 从模板到样式

| 场景 | 示例 | 跳转到 |
| --- | --- | --- |
| Vue / HTML / JSX 的 class | `class="user-card__title"` | CSS / SCSS / Sass / Less 中的选择器定义 |
| 动态 class 表达式 | `:class="['a', { 'is-active': ok }]"`、`className={clsx('a')}` | 光标所指的那一个类名 |
| id | `id="app-root"` | `#app-root` 定义 |
| CSS Modules | `styles.title`、`styles['title']`、Vue 的 `$style.title` | 只在对应模块文件中查找 |

嵌套选择器会解析出完整名称，`.user-card { &__title { } }` 可以被 `user-card__title` 命中；`@media` 等 at-rule 内部仍沿用外层父选择器。

### 组件

| 场景 | 说明 |
| --- | --- |
| `<UserCard />`、`<user-card />` | 跳转到 `UserCard.vue` / `UserCard.tsx` / `user-card/index.vue` 等组件文件 |

默认策略是 `auto`：**只有当前文件没有对应 import 语句时才介入**（也就是全局注册组件、`unplugin-vue-components` 自动导入这类原生解析不了的情况）。已经 import 的组件仍由 Volar / TypeScript 处理，不产生重复结果。

### 样式文件内部

| 语言 | 支持的符号 |
| --- | --- |
| CSS | class、id、CSS Variables（`--x`）、`@keyframes`、`@function --x()` |
| SCSS / Sass | `$变量`、`@mixin`、`@function`、`%placeholder`、class、id、`@keyframes` |
| Less | `@变量`、mixin（`.m()` / `#ns()`）、detached ruleset、class、id、`@keyframes` |
| 全部 | `@import` / `@use` / `@forward` 的路径（支持 `_partial` 与 `index` 约定） |

`@include mixins.button-base` 这类命名空间调用会正确识别为 mixin，不会被当成类选择器；`animation: fade-in` 的值会识别为 keyframes 名。

### 悬停提示

命中时在原生 Hover 中追加一行 `SymbolGo · <符号>` 与定义位置列表，可通过 `symbolgo.hover.enabled` 关闭。除此之外不注入任何装饰或界面元素。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `symbolgo.enabled` | `true` | 总开关 |
| `symbolgo.include` | 常见前端文件 glob | 参与索引的文件 |
| `symbolgo.exclude` | `node_modules`、`dist` 等 | 排除索引的文件 |
| `symbolgo.maxFiles` | `20000` | 索引文件数上限 |
| `symbolgo.maxFileSizeKB` | `1024` | 单文件体积上限 |
| `symbolgo.style.enabled` | `true` | class / id 跳转开关 |
| `symbolgo.style.scope` | `smart` | `smart` / `related` / `workspace`，见下 |
| `symbolgo.component.mode` | `auto` | `auto` / `always` / `off` |
| `symbolgo.hover.enabled` | `true` | 悬停来源标识 |
| `symbolgo.alias` | `{}` | 额外路径别名，如 `{ "@": "src" }` |
| `symbolgo.trace` | `false` | 输出详细日志 |

`style.scope` 的三种策略：

- `related`：只在当前文件与其直接关联的样式（SFC 的 `<style>` 块、`<style src>`、`@import` / `@use`、脚本里 import 的样式、HTML 的 `<link>`）中查找；
- `smart`（默认）：先按 `related` 查找，找不到时回退到整个工作区；
- `workspace`：始终返回工作区中所有同名定义。

多个结果会全部返回，由 VS Code 用原生的 Peek Definition 列表展示；排序优先级为「当前文件 → 关联样式 → 同目录 → 其余」。

### 路径别名

按以下顺序合并：`symbolgo.alias` > `tsconfig.json` / `jsconfig.json` 的 `compilerOptions.paths` > 存在 `src` 目录时的 `@/` 兜底。同时支持 webpack 风格的 `~` 前缀与 `node_modules` 内的样式文件。

## 命令

| 命令 | 说明 |
| --- | --- |
| `SymbolGo: 重建索引` | 重新全量扫描 |
| `SymbolGo: 查看索引状态` | 在输出面板打印文件数、符号数与分类统计 |
| `SymbolGo: 打开日志输出` | 打开输出面板 |

## 架构

```
src/
  extension.ts          扩展入口，只做装配与生命周期管理
  core/
    types.ts            符号种类与纯数据结构（不依赖 vscode）
    lineMap.ts          偏移 <-> 位置映射
    languages.ts        语言 / 扩展名 / 组件名归一化
    analyzer.ts         唯一解析入口：源码 -> 符号 + import 关联
    symbolIndex.ts      内存倒排索引（按 种类+名字 O(1) 查询）
    indexManager.ts     全量扫描分片、文件监听、编辑防抖
    documentCache.ts    当前文档解析结果与关联样式缓存
    pathResolver.ts     模块路径 / 别名 / partial / index 解析
    config.ts logger.ts
  parsers/              纯文本解析，全部不依赖 vscode，可单测
    styleParser.ts      CSS / SCSS / Less 单遍扫描解析器
    selector.ts         逗号拆分、& 展开、class / id 提取
    sassIndented.ts     缩进语法 Sass -> 花括号语法（带位置回映射）
    vueParser.ts        SFC 块拆分
    markupContext.ts    模板中的光标语义识别
    styleContext.ts     样式代码中的光标语义识别
    scriptImports.ts    import / require 绑定解析
  resolvers/
    symbolResolver.ts   光标位置 -> 定义位置列表（Definition 与 Hover 共用）
  providers/
    definitionProvider.ts  返回 LocationLink
    hoverProvider.ts
```

分层原则：`parsers` 不依赖 `vscode`，因此可以在普通 Node 环境下单测；`core` 负责索引与 IO；`resolvers` 是唯一的语义解析出口；`providers` 只做 VS Code API 适配。后续增加 Find References、Rename、统一搜索时，复用 `SymbolIndex` 与 `SymbolResolver` 即可，无需改动解析层。

### 性能

- 激活后做一次全量扫描，每 40 个文件让出一次事件循环，不阻塞 Extension Host；扫描期间状态栏显示进度；
- 之后靠 `FileSystemWatcher`（200ms 防抖）与文档编辑事件（350ms 防抖）增量更新，跳转时只查内存索引；
- 未保存的修改也会被索引，编辑后无需保存即可跳转；
- 文件路径解析结果带存在性缓存，文件系统变化时失效。

## 开发

```bash
pnpm install
pnpm run build          # 打包到 dist/
pnpm run watch          # 监听构建
pnpm run typecheck      # 类型检查
pnpm run test           # 解析器与跳转解析的 Node 单测（24 个用例）
pnpm run test:integration   # 在本机 VS Code 中跑真实 Extension Host 集成测试（9 个用例）
```

在 VS Code 中按 `F5` 可启动扩展开发宿主，`fixtures/demo` 是覆盖各类跳转场景的示例工作区。

集成测试通过 `vscode.executeDefinitionProvider` 触发，与用户 `Ctrl` + 左键 / `F12` 是同一条链路；可用 `VSCODE_PATH` 指定 VS Code 可执行文件位置。

## 已知限制

- 索引是纯静态解析，运行期动态拼接的类名（例如 `` `btn-${type}` ``）无法解析；
- CSS-in-JS（styled-components、emotion 等）暂未支持；
- 组件跳转基于 import 语句与文件名约定，不解析构建工具的自定义组件解析规则；
- `.vue` 与 `.sass` 在未安装对应语言扩展时会落到 plaintext，扩展已通过文件名 glob 兜底注册，但语法高亮等仍需对应扩展。

## License

MIT
