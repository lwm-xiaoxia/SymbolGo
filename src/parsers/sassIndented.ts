import type { LineMap, PositionMapper } from '../core/lineMap.js';
import type { PlainRange } from '../core/types.js';

/**
 * 缩进语法（.sass）到花括号语法的转换结果。
 *
 * `map[i]` 表示转换后文本第 i 个字符在原文中的偏移；-1 表示该字符是转换过程
 * 插入的（`{`、`}`、`;` 等），在原文中不存在。
 */
export interface ConvertedSass {
  text: string;
  map: number[];
}

interface LogicalLine {
  indent: number;
  /** 内容起始偏移（跳过缩进） */
  start: number;
  /** 内容结束偏移（含被逗号续行合并进来的部分） */
  end: number;
}

/**
 * 把缩进语法的 Sass 转成等价的花括号语法，供通用样式解析器复用。
 *
 * 只做结构层面的转换（块的开合、语句分隔、`=mixin` / `+include` 简写），
 * 不改动任何选择器或声明内容，因此解析结果与 .scss 完全一致。
 */
export function sassToBraces(source: string): ConvertedSass {
  const lines = splitLines(source);
  const logical = buildLogicalLines(source, lines);

  const out: string[] = [];
  const map: number[] = [];

  const emitSource = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      out.push(source[i]);
      map.push(i);
    }
  };
  const emitInserted = (text: string): void => {
    for (const ch of text) {
      out.push(ch);
      map.push(-1);
    }
  };

  const stack: number[] = [];
  for (let i = 0; i < logical.length; i++) {
    const line = logical[i];
    while (stack.length > 0 && stack[stack.length - 1] >= line.indent) {
      stack.pop();
      emitInserted('}');
    }

    // `=name(...)` 等价于 `@mixin name(...)`，`+name(...)` 等价于 `@include name(...)`
    const first = source[line.start];
    if (first === '=') {
      emitInserted('@mixin ');
      emitSource(line.start + 1, line.end);
    } else if (first === '+') {
      emitInserted('@include ');
      emitSource(line.start + 1, line.end);
    } else {
      emitSource(line.start, line.end);
    }

    const next = logical[i + 1];
    if (next && next.indent > line.indent) {
      emitInserted('{');
      stack.push(line.indent);
    } else {
      emitInserted(';');
    }
    emitInserted('\n');
  }
  while (stack.length > 0) {
    stack.pop();
    emitInserted('}');
  }

  return { text: out.join(''), map };
}

interface PhysicalLine {
  indent: number;
  start: number;
  end: number;
  content: string;
}

function splitLines(source: string): PhysicalLine[] {
  const result: PhysicalLine[] = [];
  let offset = 0;
  while (offset <= source.length) {
    let nl = source.indexOf('\n', offset);
    if (nl === -1) {
      nl = source.length;
    }
    let end = nl;
    if (end > offset && source[end - 1] === '\r') {
      end--;
    }
    let start = offset;
    let indent = 0;
    while (start < end && (source[start] === ' ' || source[start] === '\t')) {
      indent++;
      start++;
    }
    result.push({ indent, start, end, content: source.slice(start, end).trimEnd() });
    if (nl >= source.length) {
      break;
    }
    offset = nl + 1;
  }
  return result;
}

/**
 * 过滤空行与注释（含注释的缩进续行），并把以逗号结尾的选择器续行合并成一条逻辑行。
 */
function buildLogicalLines(source: string, lines: PhysicalLine[]): LogicalLine[] {
  const result: LogicalLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.content === '') {
      continue;
    }
    if (line.content.startsWith('//') || line.content.startsWith('/*')) {
      // 注释本体及其所有更深缩进的续行都跳过
      const base = line.indent;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.content === '' || next.indent > base) {
          i++;
        } else {
          break;
        }
      }
      continue;
    }

    let end = trimTrailing(source, line.start, line.end);
    // 选择器列表可以用逗号跨行书写
    while (source[end - 1] === ',' && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.content === '') {
        break;
      }
      i++;
      end = trimTrailing(source, next.start, next.end);
    }
    result.push({ indent: line.indent, start: line.start, end });
  }
  return result;
}

function trimTrailing(source: string, start: number, end: number): number {
  let e = end;
  while (e > start && /\s/.test(source[e - 1])) {
    e--;
  }
  return e;
}

/**
 * 把“转换后偏移”还原为原文位置。
 *
 * 起点向后、终点向前跳过插入字符，保证得到的范围一定落在原文的真实字符上。
 */
export class MappedPositionMapper implements PositionMapper {
  constructor(
    private readonly map: number[],
    private readonly origin: LineMap
  ) {}

  rangeAt(start: number, end: number): PlainRange {
    let s = Math.max(0, start);
    while (s < this.map.length && this.map[s] < 0) {
      s++;
    }
    let e = Math.min(end, this.map.length) - 1;
    while (e >= 0 && (this.map[e] ?? -1) < 0) {
      e--;
    }
    if (s >= this.map.length || e < s) {
      return this.origin.rangeAt(0, 0);
    }
    const originStart = this.map[s];
    const originEnd = this.map[e] + 1;
    return this.origin.rangeAt(originStart, Math.max(originStart, originEnd));
  }
}
