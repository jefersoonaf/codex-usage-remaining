import * as vscode from 'vscode';
import { getUsageLevel } from './config';
import { COMMANDS, EXTENSION_NAME, PROGRESS_COLORS } from './constants';
import { ExtensionSettings, TokenUsage, UsageLevel, UsageSnapshot, UsageWindow } from './types';

export class StatusBarView implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = EXTENSION_NAME;
    this.item.command = COMMANDS.showDetails;
  }

  public update(snapshot: UsageSnapshot, settings: ExtensionSettings): void {
    this.item.text = `⚡ ${formatStatusWindow('5H', snapshot.fiveHour, settings)} | ${formatStatusWindow('W', snapshot.weekly, settings)}`;
    this.item.color = new vscode.ThemeColor('statusBarItem.foreground');
    this.item.tooltip = createTooltip(snapshot, settings);
    this.item.show();
  }

  public showError(message: string): void {
    this.item.text = '🔴 Codex: Error';
    this.item.color = new vscode.ThemeColor('statusBarItem.foreground');
    this.item.tooltip = new vscode.MarkdownString(`⚠️ ${message}`);
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}

export class DetailsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  public constructor(private readonly onRefreshRequested: () => Promise<void>) {}

  public show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codexUsageRemainingDetails',
      `${EXTENSION_NAME} Details`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message: { command?: string }) => {
      if (message.command === 'refresh') {
        await this.onRefreshRequested();
      }
    });
  }

  public update(snapshot: UsageSnapshot, settings: ExtensionSettings): void {
    if (this.panel) {
      this.panel.webview.html = renderDetailsHtml(snapshot, settings);
    }
  }

  public showError(message: string): void {
    if (this.panel) {
      this.panel.webview.html = renderErrorHtml(message);
    }
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

function formatStatusWindow(label: string, usage: UsageWindow | undefined, settings: ExtensionSettings): string {
  if (!usage) {
    return `⚪ ${label}: N/A`;
  }

  return `${getStatusCircle(usage, settings)} ${label}: ${Math.round(usage.remainingPercent)}%`;
}

function getStatusCircle(usage: UsageWindow, settings: ExtensionSettings): string {
  const level = getUsageLevel(usage.remainingPercent, settings);

  switch (level) {
    case 'critical':
      return '🔴';
    case 'warning':
      return '🟡';
    default:
      return '🟢';
  }
}

function createTooltip(snapshot: UsageSnapshot, settings: ExtensionSettings): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = {
    enabledCommands: [COMMANDS.showDetails, COMMANDS.openSettings]
  };
  tooltip.supportHtml = true;
  tooltip.supportThemeIcons = true;

  tooltip.appendMarkdown(`## ⚡ ${EXTENSION_NAME}\n\n`);
  tooltip.appendMarkdown(renderTooltipWindow('5-Hour', snapshot.fiveHour, settings));
  tooltip.appendMarkdown(renderTooltipWindow('Weekly', snapshot.weekly, settings));
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(`**Source:** ${formatUsageSource(snapshot)}\n\n`);

  if (snapshot.sourceWarning) {
    tooltip.appendMarkdown(`> ⚠️ ${escapeMarkdown(snapshot.sourceWarning)}\n\n`);
  }

  tooltip.appendMarkdown(`[📊 Details](command:${COMMANDS.showDetails}) · [⚙️ Settings](command:${COMMANDS.openSettings})`);

  return tooltip;
}

function renderTooltipWindow(
  title: string,
  usage: UsageWindow | undefined,
  settings: ExtensionSettings
): string {
  if (!usage) {
    return `### ⚪ ${title}\n\nUsage data is unavailable.\n\n`;
  }

  const level = getUsageLevel(usage.remainingPercent, settings);

  return `### ${getStatusCircle(usage, settings)} ${title}\n\n` +
    `${makeTooltipBar(usage.remainingPercent, getLevelColor(level))} **${usage.remainingPercent.toFixed(1)}% remaining**\n\n` +
    `${formatResetSummary(usage)}\n\n`;
}

function makeTooltipBar(percentage: number, color: string, width = 22): string {
  const filledCount = Math.round((clampPercentage(percentage) / 100) * width);
  const emptyCount = width - filledCount;
  const filled = filledCount > 0 ? `<span style="color:${color};">${'█'.repeat(filledCount)}</span>` : '';
  const empty = emptyCount > 0 ? `<span style="color:${PROGRESS_COLORS.empty};">${'░'.repeat(emptyCount)}</span>` : '';

  return filled + empty;
}

function renderDetailsHtml(snapshot: UsageSnapshot, settings: ExtensionSettings): string {
  const warning = snapshot.sourceWarning
    ? `<div class="notice" role="status"><span class="notice-icon">⚠️</span><span>${escapeHtml(snapshot.sourceWarning)}</span></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${EXTENSION_NAME}</title>
  <style>${renderWebviewCss()}</style>
</head>
<body>
  <main class="container">
    <header class="page-header">
      <div>
        <div class="eyebrow">Codex usage</div>
        <h1>Remaining usage</h1>
      </div>
      <div class="header-actions">
        <span class="source-badge ${snapshot.rateLimitSource === 'live' ? 'live' : 'fallback'}">${formatUsageSource(snapshot)}</span>
        <button type="button" onclick="refresh()"><span>↻</span> Refresh</button>
      </div>
    </header>

    ${warning}

    <section class="usage-list" aria-label="Usage windows">
      ${renderWindowCard('🚀', '5-Hour', snapshot.fiveHour, settings)}
      ${renderWindowCard('📅', 'Weekly', snapshot.weekly, settings)}
    </section>

    <section class="token-panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Activity</div>
          <h2>Token summary</h2>
        </div>
      </div>
      <div class="token-rows">
        ${renderTokenRow('Total', snapshot.totalUsage)}
        ${renderTokenRow('Latest', snapshot.lastUsage)}
      </div>
    </section>

    <footer class="page-footer">Updated ${snapshot.updatedAt.toLocaleString()}</footer>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
}

function renderWindowCard(
  icon: string,
  title: string,
  usage: UsageWindow | undefined,
  settings: ExtensionSettings
): string {
  if (!usage) {
    return `<article class="usage-card empty-card">
      <div class="card-heading">
        <div class="card-title"><span class="card-icon">${icon}</span><h2>${title}</h2></div>
        <span class="status-chip unavailable">Unavailable</span>
      </div>
      <div class="empty-state">Usage data is unavailable for this window.</div>
    </article>`;
  }

  const level = getUsageLevel(usage.remainingPercent, settings);

  return `<article class="usage-card">
    <div class="card-heading">
      <div class="card-title"><span class="card-icon">${icon}</span><h2>${title}</h2></div>
      <span class="status-chip ${level}">${getLevelLabel(level)}</span>
    </div>

    <div class="metric">
      <div class="metric-header"><span>Remaining</span><strong>${usage.remainingPercent.toFixed(1)}%</strong></div>
      <div class="progress-track" role="progressbar" aria-label="Remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clampPercentage(usage.remainingPercent)}">
        <div class="progress-fill remaining ${level}" style="width: ${clampPercentage(usage.remainingPercent)}%"></div>
      </div>
    </div>

    <div class="reset-row">
      <strong>${formatResetCountdown(usage)}</strong>
      <span>${formatResetDate(usage)}</span>
    </div>
  </article>`;
}

function renderTokenRow(label: string, usage: TokenUsage): string {
  return `<div class="token-row">
    <strong>${label}</strong>
    <span>${formatTokenUsage(usage)}</span>
  </div>`;
}

function renderErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${renderWebviewCss()}</style></head>
<body>
  <main class="container">
    <section class="error-state">
      <div class="error-icon">⚠️</div>
      <h1>Unable to load usage</h1>
      <p>${escapeHtml(message)}</p>
      <button type="button" onclick="refresh()"><span>↻</span> Try again</button>
    </section>
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    function refresh() { vscode.postMessage({ command: 'refresh' }); }
  </script>
</body>
</html>`;
}

function renderWebviewCss(): string {
  return `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }
    .container {
      width: min(720px, 100%);
      margin: 0 auto;
      padding: 20px;
    }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .eyebrow {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1, h2, p { margin: 0; }
    h1 {
      margin-top: 1px;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: -.015em;
    }
    h2 {
      font-size: 13px;
      font-weight: 600;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .source-badge,
    .status-chip {
      display: inline-flex;
      align-items: center;
      min-height: 23px;
      padding: 2px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
    }
    .source-badge.live { color: ${PROGRESS_COLORS.safe}; }
    .source-badge.fallback { color: var(--vscode-editorWarning-foreground); }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-height: 28px;
      padding: 4px 10px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font: inherit;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .notice {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 7px;
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground);
      font-size: 12px;
    }
    .notice-icon { flex-shrink: 0; }
    .usage-list {
      display: grid;
      gap: 10px;
    }
    .usage-card,
    .token-panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
    }
    .usage-card { padding: 13px 14px; }
    .card-heading,
    .section-heading,
    .metric-header,
    .reset-row,
    .token-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .card-title {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .card-icon { font-size: 13px; }
    .status-chip.safe { color: ${PROGRESS_COLORS.safe}; }
    .status-chip.warning { color: var(--vscode-editorWarning-foreground); }
    .status-chip.critical { color: var(--vscode-errorForeground); }
    .status-chip.unavailable { color: var(--vscode-descriptionForeground); }
    .metric { margin-top: 13px; }
    .metric-header {
      margin-bottom: 5px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .metric-header strong {
      color: var(--vscode-editor-foreground);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .progress-track {
      width: 100%;
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(128, 128, 128, .22);
    }
    .progress-fill {
      height: 100%;
      border-radius: inherit;
      transition: width .25s ease;
    }
    .progress-fill.remaining.safe { background: ${PROGRESS_COLORS.safe}; }
    .progress-fill.remaining.warning { background: ${PROGRESS_COLORS.warning}; }
    .progress-fill.remaining.critical { background: ${PROGRESS_COLORS.critical}; }
    .reset-row {
      align-items: baseline;
      margin-top: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .reset-row strong {
      color: var(--vscode-editor-foreground);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .reset-row span {
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .empty-state {
      margin-top: 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .token-panel {
      margin-top: 10px;
      padding: 13px 14px;
    }
    .token-rows {
      display: grid;
      margin-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .token-row {
      align-items: flex-start;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .token-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .token-row strong { min-width: 48px; font-size: 11px; }
    .token-row span {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: right;
    }
    .page-footer {
      padding: 12px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-align: center;
    }
    .error-state {
      max-width: 520px;
      margin: 48px auto;
      padding: 24px;
      border: 1px solid var(--vscode-errorBorder);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      text-align: center;
    }
    .error-icon { margin-bottom: 7px; font-size: 22px; }
    .error-state p { margin: 7px 0 16px; color: var(--vscode-descriptionForeground); }
    @media (max-width: 560px) {
      .container { padding: 14px; }
      .page-header { align-items: flex-start; flex-direction: column; }
      .header-actions { width: 100%; justify-content: space-between; }
      .reset-row { align-items: flex-start; flex-direction: column; gap: 2px; }
      .reset-row span { text-align: left; }
      .token-row { flex-direction: column; gap: 3px; }
      .token-row span { text-align: left; }
    }
  `;
}

function formatResetSummary(usage: UsageWindow): string {
  if (!usage.resetTime) {
    return '**Reset:** unavailable';
  }

  if (usage.isExpired) {
    return `**Reset complete** · ${formatAbsoluteDate(usage.resetTime)}`;
  }

  return `**Resets in ${formatDurationUntil(usage.resetTime)}** · ${formatAbsoluteDate(usage.resetTime)}`;
}

function formatResetCountdown(usage: UsageWindow): string {
  if (!usage.resetTime) {
    return 'Reset unavailable';
  }

  if (usage.isExpired) {
    return 'Reset complete';
  }

  return `Resets in ${formatDurationUntil(usage.resetTime)}`;
}

function formatResetDate(usage: UsageWindow): string {
  if (!usage.resetTime) {
    return '—';
  }

  return formatAbsoluteDate(usage.resetTime);
}

function formatDurationUntil(resetTime: Date): string {
  const remainingMilliseconds = Math.max(0, resetTime.getTime() - Date.now());
  const totalMinutes = Math.floor(remainingMilliseconds / 60_000);

  if (totalMinutes < 1) {
    return '<1m';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

function formatAbsoluteDate(value: Date): string {
  return value.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatUsageSource(snapshot: UsageSnapshot): string {
  return snapshot.rateLimitSource === 'live' ? 'Live Codex' : 'Session fallback';
}

function getLevelLabel(level: UsageLevel): string {
  switch (level) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Low';
    default:
      return 'Available';
  }
}

function getLevelColor(level: UsageLevel): string {
  return PROGRESS_COLORS[level];
}

function formatTokenUsage(usage: TokenUsage): string {
  return `Input ${formatTokenNumber(usage.inputTokens)} · Cached ${formatTokenNumber(usage.cachedInputTokens)} · Output ${formatTokenNumber(usage.outputTokens)} · Reasoning ${formatTokenNumber(usage.reasoningOutputTokens)}`;
}

function formatTokenNumber(value: number): string {
  return `${Math.round(value / 1000).toLocaleString('en-US')} K`;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}
