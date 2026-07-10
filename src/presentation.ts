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
  tooltip.isTrusted = true;
  tooltip.supportHtml = true;
  tooltip.supportThemeIcons = true;

  tooltip.appendMarkdown(`## ⚡ ${EXTENSION_NAME}\n\n`);
  tooltip.appendMarkdown(renderTooltipWindow('🚀 5-Hour Window', snapshot.fiveHour, settings));
  tooltip.appendMarkdown(renderTooltipWindow('📅 Weekly Window', snapshot.weekly, settings));
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown('### Token activity\n\n');
  tooltip.appendMarkdown(`**Total**  \n${formatTokenUsage(snapshot.totalUsage)}\n\n`);
  tooltip.appendMarkdown(`**Latest**  \n${formatTokenUsage(snapshot.lastUsage)}\n\n`);
  tooltip.appendMarkdown(`**Source:** ${formatUsageSource(snapshot)}\n\n`);

  if (snapshot.sourceWarning) {
    tooltip.appendMarkdown(`> ⚠️ ${snapshot.sourceWarning}\n\n`);
  }

  tooltip.appendMarkdown('---\n\n');
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
  const elapsedMetric = usage.elapsedPercent === undefined
    ? '**Window elapsed** · N/A\n\n'
    : renderTooltipMetric('Window elapsed', usage.elapsedPercent, PROGRESS_COLORS.time);

  return `### ${getStatusCircle(usage, settings)} ${title}\n\n` +
    renderTooltipMetric('Remaining', usage.remainingPercent, getLevelColor(level)) +
    elapsedMetric +
    `**Resets:** ${formatResetTime(usage)}\n\n`;
}

function renderTooltipMetric(label: string, percentage: number, color: string): string {
  return `**${label}** · ${percentage.toFixed(1)}%\n\n${makeTooltipBar(percentage, color)}\n\n`;
}

function makeTooltipBar(percentage: number, color: string, width = 24): string {
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
        <p>Current availability for the active 5-hour and weekly windows.</p>
      </div>
      <div class="header-actions">
        <span class="source-badge ${snapshot.rateLimitSource === 'live' ? 'live' : 'fallback'}">${formatUsageSource(snapshot)}</span>
        <button type="button" onclick="refresh()"><span>↻</span> Refresh</button>
      </div>
    </header>

    ${warning}

    <section class="usage-grid" aria-label="Usage windows">
      ${renderWindowCard('🚀', '5-Hour Window', snapshot.fiveHour, settings)}
      ${renderWindowCard('📅', 'Weekly Window', snapshot.weekly, settings)}
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
      <div class="empty-state">No usage data is currently available for this window.</div>
    </article>`;
  }

  const level = getUsageLevel(usage.remainingPercent, settings);
  const elapsedMetric = usage.elapsedPercent === undefined
    ? renderUnavailableWebMetric('Window elapsed')
    : renderWebMetric('Window elapsed', usage.elapsedPercent, `${usage.elapsedPercent.toFixed(1)}%`, 'time');

  return `<article class="usage-card">
    <div class="card-heading">
      <div class="card-title"><span class="card-icon">${icon}</span><h2>${title}</h2></div>
      <span class="status-chip ${level}">${getLevelLabel(level)}</span>
    </div>

    <div class="metrics">
      ${renderWebMetric('Remaining', usage.remainingPercent, `${usage.remainingPercent.toFixed(1)}%`, `remaining ${level}`)}
      ${elapsedMetric}
    </div>

    <div class="reset-row">
      <span>Resets</span>
      <strong>${formatResetTime(usage)}</strong>
    </div>
  </article>`;
}

function renderWebMetric(label: string, percentage: number, text: string, cssClass: string): string {
  return `<div class="metric">
    <div class="metric-header"><span>${label}</span><strong>${text}</strong></div>
    <div class="progress-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clampPercentage(percentage)}">
      <div class="progress-fill ${cssClass}" style="width: ${clampPercentage(percentage)}%"></div>
    </div>
  </div>`;
}

function renderUnavailableWebMetric(label: string): string {
  return `<div class="metric">
    <div class="metric-header"><span>${label}</span><strong>N/A</strong></div>
    <div class="progress-track unavailable-track" aria-label="${label} unavailable"></div>
  </div>`;
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
      line-height: 1.5;
    }
    .container {
      width: min(920px, 100%);
      margin: 0 auto;
      padding: 28px;
    }
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 22px;
    }
    .eyebrow {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1, h2, p { margin: 0; }
    h1 {
      margin-top: 2px;
      font-size: 26px;
      font-weight: 650;
      letter-spacing: -.02em;
    }
    h2 {
      font-size: 15px;
      font-weight: 600;
    }
    .page-header p {
      margin-top: 5px;
      color: var(--vscode-descriptionForeground);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .source-badge,
    .status-chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 3px 9px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .source-badge.live { color: ${PROGRESS_COLORS.safe}; }
    .source-badge.fallback { color: var(--vscode-editorWarning-foreground); }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 30px;
      padding: 5px 11px;
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
      gap: 10px;
      margin-bottom: 18px;
      padding: 10px 12px;
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 8px;
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground);
    }
    .notice-icon { flex-shrink: 0; }
    .usage-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .usage-card,
    .token-panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 1px 2px rgba(0, 0, 0, .12);
    }
    .usage-card { padding: 18px; }
    .card-heading,
    .section-heading,
    .metric-header,
    .reset-row,
    .token-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .card-icon { font-size: 15px; }
    .status-chip.safe { color: ${PROGRESS_COLORS.safe}; }
    .status-chip.warning { color: var(--vscode-editorWarning-foreground); }
    .status-chip.critical { color: var(--vscode-errorForeground); }
    .status-chip.unavailable { color: var(--vscode-descriptionForeground); }
    .metrics {
      display: grid;
      gap: 17px;
      margin-top: 22px;
    }
    .metric-header {
      margin-bottom: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .metric-header strong {
      color: var(--vscode-editor-foreground);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .progress-track {
      width: 100%;
      height: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--vscode-progressBar-background, rgba(128, 128, 128, .25));
    }
    .progress-fill {
      height: 100%;
      border-radius: inherit;
      transition: width .25s ease;
    }
    .progress-fill.time { background: ${PROGRESS_COLORS.time}; }
    .progress-fill.remaining.safe { background: ${PROGRESS_COLORS.safe}; }
    .progress-fill.remaining.warning { background: ${PROGRESS_COLORS.warning}; }
    .progress-fill.remaining.critical { background: ${PROGRESS_COLORS.critical}; }
    .unavailable-track {
      opacity: .45;
      background-image: repeating-linear-gradient(135deg, transparent 0 5px, var(--vscode-panel-border) 5px 7px);
    }
    .reset-row {
      margin-top: 20px;
      padding-top: 13px;
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .reset-row strong {
      color: var(--vscode-editor-foreground);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .empty-state {
      margin-top: 22px;
      color: var(--vscode-descriptionForeground);
    }
    .token-panel {
      margin-top: 16px;
      padding: 18px;
    }
    .token-rows {
      display: grid;
      gap: 0;
      margin-top: 14px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .token-row {
      align-items: flex-start;
      padding: 11px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .token-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .token-row strong { min-width: 54px; font-size: 12px; }
    .token-row span {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: right;
    }
    .page-footer {
      padding: 18px 0 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: center;
    }
    .error-state {
      max-width: 520px;
      margin: 60px auto;
      padding: 28px;
      border: 1px solid var(--vscode-errorBorder);
      border-radius: 10px;
      background: var(--vscode-sideBar-background);
      text-align: center;
    }
    .error-icon { margin-bottom: 8px; font-size: 24px; }
    .error-state p { margin: 8px 0 18px; color: var(--vscode-descriptionForeground); }
    @media (max-width: 700px) {
      .container { padding: 18px; }
      .page-header { flex-direction: column; }
      .header-actions { width: 100%; justify-content: space-between; }
      .usage-grid { grid-template-columns: 1fr; }
      .token-row { flex-direction: column; gap: 4px; }
      .token-row span { text-align: left; }
    }
  `;
}

function formatResetTime(usage: UsageWindow): string {
  if (!usage.resetTime) {
    return 'Unavailable';
  }

  const value = usage.resetTime.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  return usage.isExpired ? `Completed ${value}` : value;
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
