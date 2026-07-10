export interface TokenUsagePayload {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface UsageLimitPayload {
  used_percent?: number;
  window_minutes?: number;
  resets_in_seconds?: number;
  resets_at?: number;
}

export interface TokenCountRecord {
  type?: string;
  timestamp: string;
  payload: {
    type: string;
    info?: {
      total_token_usage?: TokenUsagePayload | null;
      last_token_usage?: TokenUsagePayload | null;
    } | null;
    rate_limits?: {
      primary?: UsageLimitPayload;
      secondary?: UsageLimitPayload;
    };
  };
}

export interface AppServerRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface AppServerRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
}

export interface AppServerRateLimitsResponse {
  rateLimits: AppServerRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, AppServerRateLimitSnapshot | undefined> | null;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface UsageWindow {
  remainingPercent: number;
  elapsedPercent?: number;
  resetTime?: Date;
  isExpired: boolean;
}

export type RateLimitSource = 'live' | 'session';

export interface UsageSnapshot {
  updatedAt: Date;
  totalUsage: TokenUsage;
  lastUsage: TokenUsage;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  rateLimitSource: RateLimitSource;
  sourceWarning?: string;
}

export interface ExtensionSettings {
  showOutputOnError: boolean;
  codexExecutablePath: string;
  sessionPath: string;
  refreshIntervalSeconds: number;
  warningRemainingThreshold: number;
  criticalRemainingThreshold: number;
}

export type UsageLevel = 'safe' | 'warning' | 'critical';
