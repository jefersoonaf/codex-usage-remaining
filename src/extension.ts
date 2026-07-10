import * as vscode from 'vscode';
import { disposeCodexAppServerClient } from './codexAppServer';
import { getExtensionSettings } from './config';
import { COMMANDS, CONFIG_SECTION, EXTENSION_ID, EXTENSION_NAME } from './constants';
import { DetailsPanel, StatusBarView } from './presentation';
import { ExtensionSettings } from './types';
import { loadUsageSnapshot } from './usage';

let refreshTimer: NodeJS.Timeout | undefined;
let refreshInFlight: Promise<void> | undefined;
let windowFocused = true;
let statusBarView: StatusBarView | undefined;
let detailsPanel: DetailsPanel | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let lastSourceWarning: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
  statusBarView = new StatusBarView();
  detailsPanel = new DetailsPanel(refreshUsage);

  context.subscriptions.push(
    outputChannel,
    statusBarView,
    detailsPanel,
    vscode.commands.registerCommand(COMMANDS.refresh, refreshUsage),
    vscode.commands.registerCommand(COMMANDS.showDetails, async () => {
      detailsPanel?.show();
      await refreshUsage();
    }),
    vscode.commands.registerCommand(COMMANDS.openSettings, async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
    }),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      windowFocused = focused;
      if (focused) {
        startRefreshLoop();
      } else {
        stopRefreshLoop();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        startRefreshLoop();
      }
    })
  );

  startRefreshLoop();
}

export function deactivate(): void {
  stopRefreshLoop();
  disposeCodexAppServerClient();
}

function refreshUsage(): Promise<void> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = performRefresh().finally(() => {
    refreshInFlight = undefined;
  });

  return refreshInFlight;
}

async function performRefresh(): Promise<void> {
  const settings = getExtensionSettings();

  try {
    const snapshot = await loadUsageSnapshot(settings.sessionPath, settings.codexExecutablePath);
    statusBarView?.update(snapshot, settings);
    detailsPanel?.update(snapshot, settings);

    if (snapshot.sourceWarning && snapshot.sourceWarning !== lastSourceWarning) {
      logWarning(snapshot.sourceWarning);
    }
    lastSourceWarning = snapshot.sourceWarning;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(message, settings);
    statusBarView?.showError(message);
    detailsPanel?.showError(message);
  }
}

function startRefreshLoop(): void {
  stopRefreshLoop();

  if (!windowFocused) {
    return;
  }

  const settings = getExtensionSettings();
  void refreshUsage();
  refreshTimer = setInterval(() => void refreshUsage(), settings.refreshIntervalSeconds * 1000);
}

function stopRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function logWarning(message: string): void {
  const line = `[${new Date().toISOString()}] WARNING: ${message}`;
  outputChannel?.appendLine(line);
  console.warn(line);
}

function logError(message: string, settings: ExtensionSettings): void {
  const line = `[${new Date().toISOString()}] ERROR: ${message}`;
  outputChannel?.appendLine(line);
  console.error(line);

  if (settings.showOutputOnError) {
    outputChannel?.show(true);
  }
}
