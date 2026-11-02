import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJwt,
  parseUsageCredential,
  selectUsageCredential,
  readUsageCredentials,
} from "../src/auth.ts";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}

describe("JWT parsing", () => {
  it("decodes a valid JWT payload", () => {
    const payload = { sub: "user-123", email: "user@example.com" };
    const token = createJwt(payload);
    assert.deepEqual(parseJwt(token), payload);
  });

  it("returns undefined for opaque or malformed tokens", () => {
    assert.equal(parseJwt("not-a-jwt"), undefined);
    assert.equal(parseJwt("header.bad_json.sig"), undefined);
    assert.equal(parseJwt(""), undefined);
  });
});

describe("parseUsageCredential", () => {
  const fixedNow = 1_700_000_000_000;

  it("accepts valid JWT credential with accountId and email claims", () => {
    const token = createJwt({
      exp: 1_700_003_600, // +1 hour in seconds
      email: "user@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-jwt-123",
      },
    });

    const res = parseUsageCredential("openai-codex", {
      type: "oauth",
      access: token,
      expires: fixedNow + 3_600_000,
    }, fixedNow);

    assert.equal(res.status, "valid");
    if (res.status === "valid") {
      assert.deepEqual(res.credentials, {
        account: {
          provider: "openai-codex",
          accountId: "acct-jwt-123",
          email: "user@example.com",
        },
        accessToken: token,
      });
    }
  });

  it("extracts email from profile claim if top-level email is absent", () => {
    const token = createJwt({
      exp: 1_700_003_600,
      "https://api.openai.com/profile": {
        email: "profile@example.com",
      },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-jwt-456",
      },
    });

    const res = parseUsageCredential("openai", {
      type: "oauth",
      access: token,
    }, fixedNow);

    assert.equal(res.status, "valid");
    if (res.status === "valid") {
      assert.equal(res.credentials.account.email, "profile@example.com");
      assert.equal(res.credentials.account.accountId, "acct-jwt-456");
    }
  });

  it("prioritizes JWT chatgpt_account_id over stored accountId", () => {
    const token = createJwt({
      exp: 1_700_003_600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "from-jwt",
      },
    });

    const res = parseUsageCredential("openai-codex", {
      type: "oauth",
      access: token,
      accountId: "from-stored",
    }, fixedNow);

    assert.equal(res.status, "valid");
    if (res.status === "valid") {
      assert.equal(res.credentials.account.accountId, "from-jwt");
    }
  });

  it("falls back to stored accountId and email when absent from JWT", () => {
    const token = createJwt({
      exp: 1_700_003_600,
    });

    const res = parseUsageCredential("openai-codex", {
      type: "oauth",
      access: token,
      accountId: "stored-acct",
      email: "stored@example.com",
    }, fixedNow);

    assert.equal(res.status, "valid");
    if (res.status === "valid") {
      assert.equal(res.credentials.account.accountId, "stored-acct");
      assert.equal(res.credentials.account.email, "stored@example.com");
    }
  });

  it("accepts opaque token when stored accountId exists", () => {
    const opaqueToken = "opaque-access-token-xyz";
    const res = parseUsageCredential("openai-codex", {
      type: "oauth",
      access: opaqueToken,
      accountId: "acct-opaque-999",
      expires: fixedNow + 60_000,
    }, fixedNow);

    assert.equal(res.status, "valid");
    if (res.status === "valid") {
      assert.equal(res.credentials.accessToken, opaqueToken);
      assert.equal(res.credentials.account.accountId, "acct-opaque-999");
    }
  });

  it("rejects opaque token if stored accountId is missing", () => {
    const res = parseUsageCredential("openai-codex", {
      type: "oauth",
      access: "opaque-without-account",
      expires: fixedNow + 60_000,
    }, fixedNow);

    assert.equal(res.status, "malformed");
  });

  it("rejects API key credentials", () => {
    assert.equal(parseUsageCredential("openai", { type: "api_key", key: "sk-12345" }, fixedNow).status, "api_key");
    assert.equal(parseUsageCredential("openai", { key: "sk-12345" }, fixedNow).status, "api_key");
  });

  it("validates expiry boundary for stored expires (milliseconds)", () => {
    const expMs = fixedNow + 1000;
    const cred = {
      type: "oauth",
      access: "opaque-token",
      accountId: "acct-1",
      expires: expMs,
    };

    // Before boundary -> valid
    assert.equal(parseUsageCredential("openai-codex", cred, expMs - 1).status, "valid");
    // At boundary -> expired
    assert.equal(parseUsageCredential("openai-codex", cred, expMs).status, "expired");
    // Past boundary -> expired
    assert.equal(parseUsageCredential("openai-codex", cred, expMs + 1).status, "expired");
  });

  it("validates expiry boundary for stored expires (seconds)", () => {
    const expSeconds = 1_700_000_100;
    const expMs = expSeconds * 1000;
    const cred = {
      type: "oauth",
      access: "opaque-token",
      accountId: "acct-1",
      expires: expSeconds,
    };

    assert.equal(parseUsageCredential("openai-codex", cred, expMs - 1).status, "valid");
    assert.equal(parseUsageCredential("openai-codex", cred, expMs).status, "expired");
    assert.equal(parseUsageCredential("openai-codex", cred, expMs + 1).status, "expired");
  });

  it("validates JWT exp claim boundary", () => {
    const expSeconds = 1_700_000_500;
    const expMs = expSeconds * 1000;
    const token = createJwt({
      exp: expSeconds,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
    });
    const cred = { type: "oauth", access: token };

    assert.equal(parseUsageCredential("openai-codex", cred, expMs - 1).status, "valid");
    assert.equal(parseUsageCredential("openai-codex", cred, expMs).status, "expired");
    assert.equal(parseUsageCredential("openai-codex", cred, expMs + 1).status, "expired");
  });

  it("requires an explicit OAuth type, never treating arbitrary access fields as OAuth", () => {
    const base = { access: "opaque-token", accountId: "test-account", expires: fixedNow + 1000 };
    assert.equal(parseUsageCredential("openai", base, fixedNow).status, "malformed");
    assert.equal(parseUsageCredential("openai", { ...base, type: "unknown" }, fixedNow).status, "malformed");
  });

  it("rejects invalid expiry fields and treats zero expiry as expired", () => {
    const base = { type: "oauth", access: "opaque-token", accountId: "test-account" };
    assert.equal(parseUsageCredential("openai", { ...base, expires: NaN }, fixedNow).status, "malformed");
    assert.equal(parseUsageCredential("openai", { ...base, expires: "tomorrow" }, fixedNow).status, "malformed");
    assert.equal(parseUsageCredential("openai", { ...base, expires: 0 }, fixedNow).status, "expired");
    assert.equal(parseUsageCredential("openai", { type: "oauth", access: createJwt({ exp: 0 }) }, fixedNow).status, "expired");
    assert.equal(parseUsageCredential("openai", { type: "oauth", access: createJwt({ exp: "future" }) }, fixedNow).status, "malformed");
  });

  it("guards against malformed or missing credentials", () => {
    assert.equal(parseUsageCredential("openai-codex", null, fixedNow).status, "missing");
    assert.equal(parseUsageCredential("openai-codex", undefined, fixedNow).status, "missing");
    assert.equal(parseUsageCredential("openai-codex", {}, fixedNow).status, "malformed");
    assert.equal(parseUsageCredential("openai-codex", { access: "" }, fixedNow).status, "malformed");
    assert.equal(parseUsageCredential("openai-codex", { access: "   " }, fixedNow).status, "malformed");
  });
});

describe("selectUsageCredential and preference order", () => {
  const fixedNow = 1_700_000_000_000;

  it("prefers valid openai-codex over valid openai", () => {
    const codexToken = createJwt({
      exp: 1_700_010_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "codex-acct" },
    });
    const openaiToken = createJwt({
      exp: 1_700_010_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "openai-acct" },
    });

    const store: Record<string, unknown> = {
      "openai-codex": { type: "oauth", access: codexToken },
      "openai": { type: "oauth", access: openaiToken },
    };

    const creds = selectUsageCredential((id) => store[id], fixedNow);
    assert.equal(creds.account.provider, "openai-codex");
    assert.equal(creds.account.accountId, "codex-acct");
    assert.equal(creds.accessToken, codexToken);
  });

  it("falls back to valid openai when openai-codex is expired", () => {
    const expiredCodexToken = createJwt({
      exp: 1_699_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "expired-codex" },
    });
    const validOpenaiToken = createJwt({
      exp: 1_700_010_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "valid-openai" },
    });

    const store: Record<string, unknown> = {
      "openai-codex": { type: "oauth", access: expiredCodexToken },
      "openai": { type: "oauth", access: validOpenaiToken },
    };

    const creds = selectUsageCredential((id) => store[id], fixedNow);
    assert.equal(creds.account.provider, "openai");
    assert.equal(creds.account.accountId, "valid-openai");
  });

  it("falls back to valid openai when openai-codex is missing", () => {
    const validOpenaiToken = createJwt({
      exp: 1_700_010_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "valid-openai" },
    });

    const store: Record<string, unknown> = {
      "openai": { type: "oauth", access: validOpenaiToken },
    };

    const creds = selectUsageCredential((id) => store[id], fixedNow);
    assert.equal(creds.account.provider, "openai");
    assert.equal(creds.account.accountId, "valid-openai");
  });

  it("throws clear error with instructions when both are expired", () => {
    const store: Record<string, unknown> = {
      "openai-codex": { type: "oauth", access: "token-1", accountId: "a1", expires: fixedNow - 1000 },
      "openai": { type: "oauth", access: "token-2", accountId: "a2", expires: fixedNow - 1000 },
    };

    assert.throws(
      () => selectUsageCredential((id) => store[id], fixedNow),
      (err: Error) => {
        assert.match(err.message, /expired/i);
        assert.match(err.message, /\/login openai-codex or \/login openai/i);
        assert.doesNotMatch(err.message, /token-1|token-2/);
        return true;
      }
    );
  });

  it("throws specific error when only openai-codex is present and expired", () => {
    const store: Record<string, unknown> = {
      "openai-codex": { type: "oauth", access: "secret-token", accountId: "a1", expires: fixedNow - 1000 },
    };

    assert.throws(
      () => selectUsageCredential((id) => store[id], fixedNow),
      (err: Error) => {
        assert.match(err.message, /openai-codex has expired/i);
        assert.match(err.message, /\/login openai-codex/i);
        assert.doesNotMatch(err.message, /secret-token/);
        return true;
      }
    );
  });

  it("throws specific error when only openai is present and expired", () => {
    const store: Record<string, unknown> = {
      "openai": { type: "oauth", access: "secret-token", accountId: "a2", expires: fixedNow - 1000 },
    };

    assert.throws(
      () => selectUsageCredential((id) => store[id], fixedNow),
      (err: Error) => {
        assert.match(err.message, /openai has expired/i);
        assert.match(err.message, /\/login openai/i);
        assert.doesNotMatch(err.message, /secret-token/);
        return true;
      }
    );
  });

  it("explains that native direct grants cannot access numerical usage", () => {
    const direct = { type: "oauth", access: createJwt({ exp: 1_700_010_000 }), scopes: ["chatgpt.tokens.use.direct"], clientId: "test-client" };
    assert.equal(parseUsageCredential("openai", direct, fixedNow).status, "unsupported");
    assert.throws(() => selectUsageCredential((id) => id === "openai" ? direct : undefined, fixedNow), (error: Error) => {
      assert.match(error.message, /direct OpenAI OAuth/);
      assert.match(error.message, /\/login openai-codex/);
      assert.match(error.message, /https:\/\/chatgpt.com\/settings\/usage/);
      return true;
    });
  });

  it("still prefers legacy Codex when a direct grant is also stored", () => {
    const direct = { type: "oauth", access: createJwt({ exp: 1_700_010_000 }), scopes: ["chatgpt.tokens.use.direct"] };
    const legacy = { type: "oauth", access: "opaque-legacy", accountId: "test-account", expires: fixedNow + 1000 };
    assert.equal(selectUsageCredential((id) => id === "openai" ? direct : legacy, fixedNow).account.provider, "openai-codex");
  });

  it("throws clear error when credentials are API keys", () => {
    const store: Record<string, unknown> = {
      "openai": { type: "api_key", key: "sk-secret-key-12345" },
    };

    assert.throws(
      () => selectUsageCredential((id) => store[id], fixedNow),
      (err: Error) => {
        assert.match(err.message, /api keys cannot be used/i);
        assert.match(err.message, /\/login openai-codex or \/login openai/i);
        assert.doesNotMatch(err.message, /sk-secret/);
        return true;
      }
    );
  });

  it("throws clear error when no credentials exist", () => {
    assert.throws(
      () => selectUsageCredential(() => undefined, fixedNow),
      (err: Error) => {
        assert.match(err.message, /no openai oauth credentials found/i);
        assert.match(err.message, /\/login openai-codex or \/login openai/i);
        return true;
      }
    );
  });
});

describe("readUsageCredentials options injection", () => {
  it("uses injected reader and now function", () => {
    const fixedNow = 1_700_000_000_000;
    const store: Record<string, unknown> = {
      "openai-codex": {
        type: "oauth",
        access: "my-opaque-token",
        accountId: "injected-acct",
        expires: fixedNow + 10_000,
      },
    };

    const creds = readUsageCredentials({
      reader: (id) => store[id],
      now: () => fixedNow,
    });

    assert.equal(creds.account.provider, "openai-codex");
    assert.equal(creds.account.accountId, "injected-acct");
    assert.equal(creds.accessToken, "my-opaque-token");
  });
});
