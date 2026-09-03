import * as vscode from 'vscode';

export type StyleScope = 'smart' | 'related' | 'workspace';
export type ComponentMode = 'auto' | 'always' | 'off';

export interface SymbolGoConfig {
  enabled: boolean;
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxFileSizeBytes: number;
  styleEnabled: boolean;
  styleScope: StyleScope;
  componentMode: ComponentMode;
  hoverEnabled: boolean;
  alias: Record<string, string>;
  trace: boolean;
}

export const CONFIG_SECTION = 'symbolgo';

/** 读取一次配置快照。配置变更时由 Core 重新读取并广播。 */
export function readConfig(scope?: vscode.ConfigurationScope): SymbolGoConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  return {
    enabled: c.get<boolean>('enabled', true),
    include: c.get<string[]>('include', []),
    exclude: c.get<string[]>('exclude', []),
    maxFiles: c.get<number>('maxFiles', 20000),
    maxFileSizeBytes: Math.max(1, c.get<number>('maxFileSizeKB', 1024)) * 1024,
    styleEnabled: c.get<boolean>('style.enabled', true),
    styleScope: c.get<StyleScope>('style.scope', 'smart'),
    componentMode: c.get<ComponentMode>('component.mode', 'auto'),
    hoverEnabled: c.get<boolean>('hover.enabled', true),
    alias: c.get<Record<string, string>>('alias', {}),
    trace: c.get<boolean>('trace', false)
  };
}

/** 把 include / exclude 数组拼成 vscode.findFiles 需要的 glob 字符串。 */
export function toGlob(patterns: string[]): string | undefined {
  const list = patterns.filter((p) => p.trim().length > 0);
  if (list.length === 0) {
    return undefined;
  }
  return list.length === 1 ? list[0] : `{${list.join(',')}}`;
}
