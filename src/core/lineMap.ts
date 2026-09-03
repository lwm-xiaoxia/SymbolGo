import type { PlainPosition, PlainRange } from './types.js';

/**
 * 偏移量 -> 位置 的映射能力。
 *
 * 缩进语法的 Sass 需要先转成花括号语法再解析，转换后的偏移与原文不一致，
 * 因此解析器只依赖这个接口，由调用方决定如何还原到原文位置。
 */
export interface PositionMapper {
  rangeAt(start: number, end: number): PlainRange;
}

/**
 * 把字符串偏移量映射为 行/列 位置。
 *
 * 解析器内部只用偏移量（快、简单），最终产出符号时才转换成位置。
 * 行首偏移表只构建一次，查找用二分，避免逐字符统计换行。
 */
export class LineMap implements PositionMapper {
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      // 10 = \n，13 = \r。统一在换行符之后开新行，\r\n 只算一次。
      if (ch === 10) {
        starts.push(i + 1);
      } else if (ch === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          i++;
        }
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  positionAt(offset: number): PlainPosition {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { line: low, character: clamped - this.lineStarts[low] };
  }

  rangeAt(start: number, end: number): PlainRange {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }

  offsetAt(position: PlainPosition): number {
    const line = Math.max(0, Math.min(position.line, this.lineStarts.length - 1));
    return Math.min(this.lineStarts[line] + Math.max(0, position.character), this.text.length);
  }
}
