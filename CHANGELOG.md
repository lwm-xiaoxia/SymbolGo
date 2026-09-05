# 更新日志

## 1.0.1

新增插件图标。

## 1.0.0

首个正式版本，功能与 0.1.0 一致。

## 0.1.0

首个版本。

- Vue / HTML / JSX 中的 `class`、`id` 跳转到 CSS / SCSS / Sass / Less 定义，支持动态 class 表达式与 CSS Modules 成员访问
- SCSS / Less 嵌套选择器解析出完整名称（`&__title` 可被 `user-card__title` 命中）
- Vue / React 组件跳转，默认只在当前文件无对应 import 时介入，避免与内置 JS/TS 跳转重复
- 样式文件内部符号跳转：CSS Variables、`@keyframes`、CSS `@function`、SCSS 变量 / mixin / function / placeholder、Less 变量 / mixin / detached ruleset
- `@import` / `@use` / `@forward` 路径跳转，支持 `_partial` 与 `index` 约定、tsconfig/jsconfig 别名、webpack 风格 `~` 前缀
- 轻量内存索引：分片全量扫描 + 文件监听与编辑防抖增量更新
- Hover 中显示 `SymbolGo` 来源标识与定义位置
