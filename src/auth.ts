import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { UsageAccount, UsageCredentials, UsageProvider } from "./types.ts";

export type { UsageCredentials };

export interface ReadUsageCredentialsOptions {
  reader?: (providerId: string) => unknown;
  now?: () => number;
}

/** Pi owns path resolution, including PI_CODING_AGENT_DIR and tilde expansion. */
export function defaultCredentialReader(providerId: string): unknown {
  return readStoredCredential(providerId);
}

export function parseJwt(token: string): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type CredentialEvaluation =
  | { status: "valid"; credentials: UsageCredentials }
  | { status: "expired"; provider: UsageProvider; expiresAt?: number }
  | { status: "api_key"; provider: UsageProvider }
  | { status: "unsupported"; provider: UsageProvider }
  | { status: "missing"; provider: UsageProvider }
  | { status: "malformed"; provider: UsageProvider; reason: string };

export function parseUsageCredential(
  provider: UsageProvider,
  raw: unknown,
  nowMs: number = Date.now()
): CredentialEvaluation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "missing", provider };
  }

  const cred = raw as Record<string, unknown>;

  // Never API keys: reject explicitly if typed as api_key or has key without access
  if (cred.type === "api_key" || (typeof cred.key === "string" && !cred.access)) {
    return { status: "api_key", provider };
  }

  if (cred.type !== "oauth") {
    return { status: "malformed", provider, reason: "Expected an OAuth credential" };
  }

  // Validate access token
  if (typeof cred.access !== "string" || !cred.access.trim()) {
    return { status: "malformed", provider, reason: "Missing or invalid access token" };
  }
  const accessToken = cred.access.trim();

  // Expiry from stored credential (supports both ms and seconds timestamps)
  let storedExpiresMs: number | undefined;
  if (cred.expires !== undefined) {
    if (typeof cred.expires !== "number" || !Number.isFinite(cred.expires)) {
      return { status: "malformed", provider, reason: "Invalid credential expiry" };
    }
    storedExpiresMs = cred.expires < 1e11 ? cred.expires * 1000 : cred.expires;
  }

  // JWT parsing & boundary validation
  const jwtPayload = parseJwt(accessToken);
  let jwtExpMs: number | undefined;
  let jwtAccountId: string | undefined;
  let jwtEmail: string | undefined;

  if (jwtPayload) {
    if (jwtPayload.exp !== undefined) {
      if (typeof jwtPayload.exp !== "number" || !Number.isFinite(jwtPayload.exp)) {
        return { status: "malformed", provider, reason: "Invalid token expiry" };
      }
      jwtExpMs = jwtPayload.exp * 1000;
    }

    const authClaim = jwtPayload["https://api.openai.com/auth"];
    if (typeof authClaim === "object" && authClaim !== null) {
      const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string" && id.trim()) {
        jwtAccountId = id.trim();
      }
    }

    if (typeof jwtPayload.email === "string" && jwtPayload.email.trim()) {
      jwtEmail = jwtPayload.email.trim();
    } else {
      const profileClaim = jwtPayload["https://api.openai.com/profile"];
      if (typeof profileClaim === "object" && profileClaim !== null) {
        const email = (profileClaim as Record<string, unknown>).email;
        if (typeof email === "string" && email.trim()) {
          jwtEmail = email.trim();
        }
      }
    }
  }

  // Account ID: JWT https://api.openai.com/auth.chatgpt_account_id then stored accountId
  const storedAccountId = typeof cred.accountId === "string" && cred.accountId.trim() ? cred.accountId.trim() : undefined;
  const accountId = jwtAccountId ?? storedAccountId;

  // If access opaque but stored accountId exists allow
  const isOpaque = !jwtPayload;
  if (isOpaque && !storedAccountId) {
    return { status: "malformed", provider, reason: "Opaque token requires stored accountId" };
  }

  // Optional email from JWT top-level or https://api.openai.com/profile, then stored email
  const storedEmail = typeof cred.email === "string" && cred.email.trim() ? cred.email.trim() : undefined;
  const email = jwtEmail ?? storedEmail;

  // Native Sign in with ChatGPT grants target api.openai.com, not the legacy
  // ChatGPT usage API. Refreshing or repeating that login cannot grant access.
  const jwtScopes = typeof jwtPayload?.scope === "string" ? jwtPayload.scope.split(/\s+/) : jwtPayload?.scopes;
  if ((Array.isArray(cred.scopes) && cred.scopes.includes("chatgpt.tokens.use.direct")) ||
      (Array.isArray(jwtScopes) && jwtScopes.includes("chatgpt.tokens.use.direct"))) {
    return { status: "unsupported", provider };
  }

  // Boundary check: token is considered expired when nowMs >= expires boundary.
  if (storedExpiresMs !== undefined && nowMs >= storedExpiresMs) {
    return { status: "expired", provider, expiresAt: storedExpiresMs };
  }
  if (jwtExpMs !== undefined && nowMs >= jwtExpMs) {
    return { status: "expired", provider, expiresAt: jwtExpMs };
  }

  return {
    status: "valid",
    credentials: {
      account: {
        provider,
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
      },
      accessToken,
    },
  };
}

export function selectUsageCredential(
  reader: (providerId: string) => unknown,
  nowMs: number = Date.now()
): UsageCredentials {
  const codexRaw = reader("openai-codex");
  const codexEval = parseUsageCredential("openai-codex", codexRaw, nowMs);
  if (codexEval.status === "valid") {
    return codexEval.credentials;
  }

  const openaiRaw = reader("openai");
  const openaiEval = parseUsageCredential("openai", openaiRaw, nowMs);
  if (openaiEval.status === "valid") {
    return openaiEval.credentials;
  }

  // Both failed to produce valid credentials - provide differentiated, actionable errors
  if (codexEval.status === "expired" && openaiEval.status === "expired") {
    throw new Error("OpenAI OAuth tokens have expired. Use OpenAI in Pi to refresh them, or reconnect with /login openai-codex or /login openai.");
  }
  if (codexEval.status === "expired") {
    throw new Error("OpenAI OAuth token for openai-codex has expired. Use this provider in Pi to refresh it, or reconnect with /login openai-codex.");
  }
  if (openaiEval.status === "expired") {
    throw new Error("OpenAI OAuth token for openai has expired. Use this provider in Pi to refresh it, or reconnect with /login openai.");
  }

  if (codexEval.status === "unsupported" || openaiEval.status === "unsupported") {
    throw new Error("This direct OpenAI OAuth login cannot read numeric usage. Add /login openai-codex for 5h/weekly quotas, or view https://chatgpt.com/settings/usage. Your existing openai login is unchanged.");
  }

  if (codexEval.status === "api_key" || openaiEval.status === "api_key") {
    throw new Error("OpenAI API keys cannot be used for ChatGPT subscription usage. Sign in with OAuth using /login openai-codex or /login openai.");
  }

  if (codexEval.status === "malformed") {
    throw new Error("OpenAI OAuth credential for openai-codex is malformed. Sign in again with /login openai-codex.");
  }
  if (openaiEval.status === "malformed") {
    throw new Error("OpenAI OAuth credential for openai is malformed. Sign in again with /login openai.");
  }

  throw new Error("No OpenAI OAuth credentials found. Sign in with /login openai-codex or /login openai.");
}

export function readUsageCredentials(options?: ReadUsageCredentialsOptions): UsageCredentials {
  const reader = options?.reader ?? defaultCredentialReader;
  const nowMs = options?.now ? options.now() : Date.now();
  return selectUsageCredential(reader, nowMs);
}
