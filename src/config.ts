import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULTS } from './constants';
import { ExtensionSettings, UsageLevel } from './types';

export function getExtensionSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const warningRemainingThreshold = clampPercentage(
    configuration.get<number>('warningRemainingThreshold', DEFAULTS.warningRemainingThreshold)
  );
  const criticalRemainingThreshold = Math.min(
    warningRemainingThreshold,
    clampPercentage(configuration.get<number>('criticalRemainingThreshold', DEFAULTS.criticalRemainingThreshold))
  );
  const configuredSessionPath = configuration.get<string>('sessionPath', '').trim();
  const configuredExecutable = configuration
    .get<string>('codexExecutablePath', DEFAULTS.codexExecutablePath)
    .trim();

  return {
    showOutputOnError: configuration.get<boolean>('showOutputOnError', false),
    codexExecutablePath: resolveExecutable(configuredExecutable),
    sessionPath: resolveSessionPath(configuredSessionPath),
    refreshIntervalSeconds: Math.min(
      DEFAULTS.maximumRefreshIntervalSeconds,
      Math.max(
        DEFAULTS.minimumRefreshIntervalSeconds,
        configuration.get<number>('refreshInterval', DEFAULTS.refreshIntervalSeconds)
      )
    ),
    warningRemainingThreshold,
    criticalRemainingThreshold
  };
}

export function getUsageLevel(remainingPercent: number, settings: ExtensionSettings): UsageLevel {
  if (remainingPercent <= settings.criticalRemainingThreshold) {
    return 'critical';
  }

  if (remainingPercent <= settings.warningRemainingThreshold) {
    return 'warning';
  }

  return 'safe';
}

function resolveExecutable(configuredExecutable: string): string {
  const value = configuredExecutable || DEFAULTS.codexExecutablePath;

  if (value.startsWith('~')) {
    return path.resolve(path.join(os.homedir(), value.slice(1)));
  }

  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return path.resolve(value);
  }

  return value;
}

function resolveSessionPath(configuredPath: string): string {
  if (!configuredPath) {
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  const expandedPath = configuredPath.startsWith('~')
    ? path.join(os.homedir(), configuredPath.slice(1))
    : configuredPath;

  return path.resolve(expandedPath);
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}
