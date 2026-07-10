import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { fetchLiveRateLimits } from './codexAppServer';
import { DEFAULTS } from './constants';
import {
  AppServerRateLimitSnapshot,
  AppServerRateLimitWindow,
  AppServerRateLimitsResponse,
  TokenCountRecord,
  TokenUsage,
  TokenUsagePayload,
  UsageLimitPayload,
  UsageSnapshot,
  UsageWindow
} from './types';

interface SessionFileCandidate {
  filePath: string;
  modifiedAt: number;
}

const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
};

export async function loadUsageSnapshot(
  sessionPath: string,
  codexExecutablePath: string
): Promise<UsageSnapshot> {
  const [liveResult, sessionResult] = await Promise.allSettled([
    fetchLiveRateLimits(codexExecutablePath),
    findLatestTokenCountRecord(sessionPath)
  ]);

  const sessionRecord = sessionResult.status === 'fulfilled' ? sessionResult.value : undefined;
  const totalUsage = normalizeTokenUsage(sessionRecord?.payload.info?.total_token_usage);
  const lastUsage = normalizeTokenUsage(sessionRecord?.payload.info?.last_token_usage);

  if (liveResult.status === 'fulfilled') {
    const liveSnapshot = selectCodexRateLimitSnapshot(liveResult.value);
    const fiveHour = buildLiveUsageWindow(liveSnapshot.primary);
    const weekly = buildLiveUsageWindow(liveSnapshot.secondary);

    if (fiveHour || weekly) {
      return {
        updatedAt: new Date(),
        totalUsage,
        lastUsage,
        fiveHour,
        weekly,
        rateLimitSource: 'live'
      };
    }
  }

  const sessionLimits = sessionRecord?.payload.rate_limits;
  const recordTimestamp = sessionRecord ? parseTimestamp(sessionRecord.timestamp) : undefined;
  const fiveHour = recordTimestamp && sessionLimits?.primary
    ? buildSessionUsageWindow(recordTimestamp, sessionLimits.primary)
    : undefined;
  const weekly = recordTimestamp && sessionLimits?.secondary
    ? buildSessionUsageWindow(recordTimestamp, sessionLimits.secondary)
    : undefined;

  if (fiveHour || weekly) {
    return {
      updatedAt: new Date(),
      totalUsage,
      lastUsage,
      fiveHour,
      weekly,
      rateLimitSource: 'session',
      sourceWarning: getLiveFallbackWarning(liveResult)
    };
  }

  throw new Error(buildUnavailableMessage(liveResult, sessionResult, sessionPath));
}

function selectCodexRateLimitSnapshot(response: AppServerRateLimitsResponse): AppServerRateLimitSnapshot {
  const buckets = response.rateLimitsByLimitId;
  if (buckets) {
    const codexEntry = Object.entries(buckets).find(([key, value]) =>
      key.toLowerCase() === 'codex' && value !== undefined
    );

    if (codexEntry?.[1]) {
      return codexEntry[1];
    }
  }

  return response.rateLimits;
}

function buildLiveUsageWindow(limit?: AppServerRateLimitWindow | null): UsageWindow | undefined {
  if (!limit || !Number.isFinite(limit.usedPercent)) {
    return undefined;
  }

  return buildUsageWindow(limit.usedPercent, parseUnixTimestamp(limit.resetsAt));
}

function buildSessionUsageWindow(recordTimestamp: Date, limit: UsageLimitPayload): UsageWindow {
  return buildUsageWindow(limit.used_percent ?? 0, calculateSessionResetTime(recordTimestamp, limit));
}

function buildUsageWindow(usedPercent: number, resetTime: Date | undefined): UsageWindow {
  const now = new Date();
  const isExpired = resetTime !== undefined && resetTime.getTime() <= now.getTime();
  const remainingPercent = isExpired ? 100 : clampPercentage(100 - usedPercent);

  return {
    remainingPercent,
    resetTime,
    isExpired
  };
}

function calculateSessionResetTime(recordTimestamp: Date, limit: UsageLimitPayload): Date | undefined {
  if (typeof limit.resets_at === 'number' && Number.isFinite(limit.resets_at)) {
    return parseUnixTimestamp(limit.resets_at);
  }

  if (typeof limit.resets_in_seconds === 'number' && Number.isFinite(limit.resets_in_seconds)) {
    const resetTime = new Date(recordTimestamp.getTime() + limit.resets_in_seconds * 1000);
    return Number.isFinite(resetTime.getTime()) ? resetTime : undefined;
  }

  return undefined;
}

async function findLatestTokenCountRecord(sessionPath: string): Promise<TokenCountRecord | undefined> {
  const files = await findCandidateSessionFiles(sessionPath);
  let latestRecord: TokenCountRecord | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const filePath of files) {
    const record = await readLatestTokenCountRecord(filePath);
    if (!record) {
      continue;
    }

    const timestamp = parseTimestamp(record.timestamp).getTime();
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
      latestRecord = record;
    }
  }

  return latestRecord;
}

async function findCandidateSessionFiles(sessionPath: string): Promise<string[]> {
  if (!fs.existsSync(sessionPath)) {
    return [];
  }

  const pattern = path.join(sessionPath, '**', 'rollout-*.jsonl').replace(/\\/g, '/');
  const matches = await glob(pattern, { nodir: true });
  const candidates: SessionFileCandidate[] = [];

  for (const filePath of matches) {
    try {
      const stats = await fs.promises.stat(filePath);
      candidates.push({ filePath, modifiedAt: stats.mtimeMs });
    } catch {
      // A session file can disappear while Codex archives or rotates it.
    }
  }

  return candidates
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, DEFAULTS.maximumSessionCandidates)
    .map((candidate) => candidate.filePath);
}

async function readLatestTokenCountRecord(filePath: string): Promise<TokenCountRecord | undefined> {
  const content = await readFileTail(filePath, DEFAULTS.sessionTailBytes);
  const lines = content.split('\n');
  let latestRecord: TokenCountRecord | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line) as TokenCountRecord;
      const isEventMessage = record.type === undefined || record.type === 'event_msg';
      if (!isEventMessage || record.payload?.type !== 'token_count') {
        continue;
      }

      const timestamp = parseTimestamp(record.timestamp).getTime();
      if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestRecord = record;
      }
    } catch {
      // Session files are JSONL; malformed or partial lines are ignored.
    }
  }

  return latestRecord;
}

async function readFileTail(filePath: string, maximumBytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');

  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maximumBytes);
    const start = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    let content = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
    }

    return content;
  } finally {
    await handle.close();
  }
}

function normalizeTokenUsage(usage?: TokenUsagePayload | null): TokenUsage {
  if (!usage) {
    return { ...EMPTY_TOKEN_USAGE };
  }

  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0
  };
}

function getLiveFallbackWarning(
  liveResult: PromiseSettledResult<AppServerRateLimitsResponse>
): string {
  if (liveResult.status === 'rejected') {
    const reason = liveResult.reason instanceof Error ? liveResult.reason.message : String(liveResult.reason);
    return `Live Codex usage is unavailable; showing the session fallback. ${reason}`;
  }

  return 'Live Codex response did not contain usage windows; showing the session fallback.';
}

function buildUnavailableMessage(
  liveResult: PromiseSettledResult<AppServerRateLimitsResponse>,
  sessionResult: PromiseSettledResult<TokenCountRecord | undefined>,
  sessionPath: string
): string {
  const liveReason = liveResult.status === 'rejected'
    ? liveResult.reason instanceof Error
      ? liveResult.reason.message
      : String(liveResult.reason)
    : 'The live response did not contain usage windows.';
  const sessionReason = sessionResult.status === 'rejected'
    ? sessionResult.reason instanceof Error
      ? sessionResult.reason.message
      : String(sessionResult.reason)
    : `No token_count events were found under ${sessionPath}.`;

  return `Unable to load Codex usage. Live source: ${liveReason} Session fallback: ${sessionReason}`;
}

function parseTimestamp(value: string): Date {
  return new Date(value);
}

function parseUnixTimestamp(value?: number | null): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}
