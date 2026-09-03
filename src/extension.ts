import * as vscode from 'vscode';
import { CONFIG_SECTION, readConfig } from './core/config.js';
import type { SymbolGoConfig } from './core/config.js';
import { DocumentCache } from './core/documentCache.js';
import { IndexManager } from './core/indexManager.js';
import { FILE_PATTERNS, MARKUP_LANGUAGES, STYLE_LANGUAGES } from './core/languages.js';
import { Logger } from './core/logger.js';
import { PathResolver } from './core/pathResolver.js';
import { SymbolGoDefinitionProvider } from './providers/definitionProvider.js';
import { SymbolGoHoverProvider } from './providers/hoverProvider.js';
import { SymbolResolver } from './resolvers/symbolResolver.js';

/**
 * 扩展入口：只做装配与生命周期管理，具体能力都在 core / parsers / resolvers / providers 中。
 *
 * 组装顺序：配置 -> 日志 -> 路径解析 -> 索引 -> 文档缓存 -> 跳转解析 -> Provider。
 * 各层之间只通过构造参数依赖，方便后续追加 Find References、Rename 等 Provider。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let config: SymbolGoConfig = readConfig();

  const logger = new Logger();
  logger.setTrace(config.trace);
  context.subscriptions.push(logger);

  const pathResolver = new PathResolver(logger);
  await pathResolver.reloadAliases(config);

  const documentCache = new DocumentCache(pathResolver);

  const indexManager = new IndexManager(config, logger, () => {
    // 索引变化后，文档级缓存（尤其是已解析的样式关联）可能失效
    pathResolver.invalidate();
    documentCache.invalidate();
  });
  context.subscriptions.push(indexManager);

  const resolver = new SymbolResolver(
    indexManager.index,
    documentCache,
    pathResolver,
    logger,
    () => config
  );

  const definitionProvider = new SymbolGoDefinitionProvider(resolver, logger);
  const hoverProvider = new SymbolGoHoverProvider(resolver, logger, () => config);

  const selectors: vscode.DocumentSelector = [
    ...[...MARKUP_LANGUAGES, ...STYLE_LANGUAGES].map((language) => ({ language, scheme: 'file' })),
    ...FILE_PATTERNS.map((pattern) => ({ pattern, scheme: 'file' }))
  ];

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selectors, definitionProvider),
    vscode.languages.registerHoverProvider(selectors, hoverProvider)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      const previous = config;
      config = readConfig();
      logger.setTrace(config.trace);
      indexManager.updateConfig(config);
      await pathResolver.reloadAliases(config);
      documentCache.invalidate();

      // 只有影响扫描范围的配置变化才值得重建索引
      const scopeChanged =
        JSON.stringify(previous.include) !== JSON.stringify(config.include) ||
        JSON.stringify(previous.exclude) !== JSON.stringify(config.exclude) ||
        previous.maxFiles !== config.maxFiles;
      if (scopeChanged) {
        logger.info('索引范围配置已变更，正在重建索引');
        await indexManager.rebuild();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await pathResolver.reloadAliases(config);
      await indexManager.rebuild();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('symbolgo.rebuildIndex', async () => {
      pathResolver.invalidate();
      documentCache.invalidate();
      await pathResolver.reloadAliases(config);
      await indexManager.rebuild();
      void vscode.window.showInformationMessage('SymbolGo：索引已重建');
    }),
    vscode.commands.registerCommand('symbolgo.showIndexStats', () => {
      const stats = indexManager.index.stats();
      const detail = Object.entries(stats.byKind)
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `  ${kind}: ${count}`)
        .join('\n');
      logger.info(
        `索引状态：${stats.files} 个文件，${stats.symbols} 个符号，${stats.components} 个组件\n${detail}`
      );
      logger.show();
    }),
    vscode.commands.registerCommand('symbolgo.showOutput', () => logger.show())
  );

  indexManager.start();
  logger.info('SymbolGo 已激活');
}

export function deactivate(): void {
  // 资源全部通过 context.subscriptions 释放，这里无需额外处理
}
