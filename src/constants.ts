export const EXTENSION_NAME = 'Codex Usage Remaining';
export const EXTENSION_ID = 'jefersoonaf.codex-usage-remaining';
export const CONFIG_SECTION = 'codexUsageRemaining';

export const COMMANDS = {
  refresh: 'codex-usage-remaining.refresh',
  showDetails: 'codex-usage-remaining.showDetails',
  openSettings: 'codex-usage-remaining.openSettings'
} as const;

export const DEFAULTS = {
  codexExecutablePath: 'codex',
  refreshIntervalSeconds: 10,
  minimumRefreshIntervalSeconds: 5,
  maximumRefreshIntervalSeconds: 3600,
  warningRemainingThreshold: 30,
  criticalRemainingThreshold: 10,
  maximumSessionCandidates: 20,
  sessionTailBytes: 2 * 1024 * 1024
} as const;

export const PROGRESS_COLORS = {
  safe: '#4CAF50',
  warning: '#F3D898',
  critical: '#ECA7A7',
  empty: '#555555'
} as const;
