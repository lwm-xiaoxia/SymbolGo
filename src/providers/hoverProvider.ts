import * as vscode from 'vscode';
import type { SymbolGoConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { SymbolResolver } from '../resolvers/symbolResolver.js';

/** Hover 中最多列出的定义条数，超出部分只显示数量。 */
const MAX_LISTED = 5;

/**
 * 悬停提示 Provider。
 *
 * 只在 SymbolGo 真的解析出结果时才返回内容，并且只输出一小段 Markdown：
 * 一行来源标识 + 定义所在文件。不注入装饰、不改变编辑器外观。
 */
export class SymbolGoHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly resolver: SymbolResolver,
    private readonly logger: Logger,
    private readonly getConfig: () => SymbolGoConfig
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    if (!this.getConfig().hoverEnabled) {
      return undefined;
    }
    try {
      const result = await this.resolver.resolve(document, position);
      if (!result || token.isCancellationRequested || result.targets.length === 0) {
        return undefined;
      }

      const md = new vscode.MarkdownString();
      md.isTrusted = false;
      md.supportThemeIcons = true;
      md.appendMarkdown(`$(symbol-color) **SymbolGo** · ${result.label}\n\n`);

      for (const target of result.targets.slice(0, MAX_LISTED)) {
        const location = `${vscode.workspace.asRelativePath(target.uri)}:${target.range.start.line + 1}`;
        md.appendMarkdown(`- ${location}\n`);
      }
      const rest = result.targets.length - MAX_LISTED;
      if (rest > 0) {
        md.appendMarkdown(`- 另有 ${rest} 处定义\n`);
      }

      const detail = result.targets[0].detail;
      if (detail) {
        md.appendCodeblock(truncate(detail, 200), 'css');
      }

      return new vscode.Hover(md, result.origin);
    } catch (error) {
      this.logger.error('生成悬停提示失败', error);
      return undefined;
    }
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
