export type UsageProvider = "openai-codex" | "openai";

export interface UsageAccount {
  provider: UsageProvider;
  accountId?: string;
  email?: string;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowSeconds: number;
  resetsAt?: number; // Unix milliseconds
}

export interface UsageSnapshot {
  account: UsageAccount;
  plan?: string;
  windows: UsageWindow[];
  fetchedAt: number;
  limitReached: boolean;
}

export interface UsageState {
  snapshot?: UsageSnapshot;
  loading: boolean;
  error?: string;
  updatedAt?: number;
}

export interface UsageCredentials {
  account: UsageAccount;
  accessToken: string;
}
