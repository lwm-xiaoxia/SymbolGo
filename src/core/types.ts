/**
 * SymbolGo 内部通用类型定义。
 *
 * 说明：本文件（以及 src/parsers 下的解析器）刻意不依赖 `vscode` 模块，
 * 目的是让解析逻辑可以在普通 Node 环境下单测，也便于将来迁移到 LSP 进程。
 */

/** 索引中记录的符号种类。不同前缀语法（$ / @ / -- / %）属于不同命名空间，必须分开。 */
export enum SymbolKind {
  /** CSS 类选择器，name 不含前导 `.` */
  CssClass = 'css.class',
  /** CSS id 选择器，name 不含前导 `#` */
  CssId = 'css.id',
  /** CSS 自定义属性（CSS Variables），name 含前导 `--` */
  CssVariable = 'css.variable',
  /** `@keyframes name` */
  Keyframes = 'css.keyframes',
  /** CSS `@function --name()`（CSS Functions 规范） */
  CssFunction = 'css.function',
  /** SCSS / Sass 变量 `$name`，name 不含 `$` */
  ScssVariable = 'scss.variable',
  /** SCSS / Sass `@mixin name` */
  ScssMixin = 'scss.mixin',
  /** SCSS / Sass `@function name` */
  ScssFunction = 'scss.function',
  /** SCSS / Sass 占位符 `%name`，name 不含 `%` */
  ScssPlaceholder = 'scss.placeholder',
  /** Less 变量 `@name`，name 不含 `@` */
  LessVariable = 'less.variable',
  /** Less mixin 定义 `.name()` / `#name()`，name 不含前导符号 */
  LessMixin = 'less.mixin',
  /** 组件（.vue / .jsx / .tsx 等文件维度的组件） */
  Component = 'component'
}

/** 样式方言。sass 指缩进语法，scss 指花括号语法。 */
export type StyleSyntax = 'css' | 'scss' | 'sass' | 'less';

/** 与 vscode.Position 结构一致的纯数据位置，避免解析层依赖 vscode。 */
export interface PlainPosition {
  line: number;
  character: number;
}

export interface PlainRange {
  start: PlainPosition;
  end: PlainPosition;
}

/** 解析器产出的符号（尚未绑定所属文件）。 */
export interface RawSymbol {
  kind: SymbolKind;
  /** 归一化后的符号名，作为索引 key 的一部分 */
  name: string;
  /** 精确指向名字本身的范围，用于跳转后光标定位 */
  range: PlainRange;
  /** 包含整条选择器 / 声明的范围，用于 hover 预览 */
  fullRange?: PlainRange;
  /** 展示用的补充信息，例如完整选择器文本、mixin 签名 */
  detail?: string;
  /** 所属容器，例如嵌套时的父选择器 */
  container?: string;
}

/** 索引中的符号条目（已绑定文件）。 */
export interface SymbolEntry extends RawSymbol {
  /** 文件 uri 的字符串形式 */
  uri: string;
}

/** 一次样式文件解析的完整结果。 */
export interface StyleParseResult {
  symbols: RawSymbol[];
  /** `@import` / `@use` / `@forward` 引用的原始路径（未解析） */
  imports: string[];
}

/** 光标处识别出的“待跳转目标”。 */
export interface SymbolRequest {
  /** 允许命中的符号种类，按优先级排列 */
  kinds: SymbolKind[];
  /** 归一化后的查找名 */
  name: string;
  /** 光标下被识别为符号的原始文本范围，用于 hover 高亮 */
  range: PlainRange;
  /**
   * 限定查找的文件集合（uri 字符串）。为空表示不限定。
   * 例如 CSS Modules 的 `styles.foo` 只应在对应模块文件中查找。
   */
  restrictToFiles?: string[];
}
