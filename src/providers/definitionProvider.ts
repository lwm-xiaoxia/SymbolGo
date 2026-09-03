import * as vscode from 'vscode';
import type { Logger } from '../core/logger.js';
import type { SymbolResolver } from '../resolvers/symbolResolver.js';

/**
 * 定义跳转 Provider。
 *
 * 返回 `LocationLink` 而不是 `Location`：可以额外提供 `originSelectionRange`，
 * 让 Ctrl + 悬停时下划线正好覆盖识别出的那一个 class / 变量名。
 * 多个结果时直接全部返回，由 VS Code 用原生的“Peek Definition”列表展示。
 */
export class SymbolGoDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly resolver: SymbolResolver,
    private readonly logger: Logger
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.LocationLink[] | undefined> {
    try {
      const result = await this.resolver.resolve(document, position);
      if (!result || token.isCancellationRequested || result.targets.length === 0) {
        return undefined;
      }
      return result.targets.map((target) => ({
        originSelectionRange: result.origin,
        targetUri: target.uri,
        targetRange: target.fullRange,
        targetSelectionRange: target.range
      }));
    } catch (error) {
      this.logger.error('解析定义失败', error);
      return undefined;
    }
  }
}
