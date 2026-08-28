import crypto from "crypto";

// In-memory store for demo purposes. Replace with persistent storage.
const tokenStore = new Map<string, { hash: string; expiresAt: number; revoked: boolean }>();

/** Generate a high-entropy token and store its hash. */
export function createUnlistedToken(ttlMs: number = 7 * 24 * 60 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + ttlMs;
  tokenStore.set(hash, { hash, expiresAt, revoked: false });
  return token; // return raw token to caller (to embed in URL)
}

/** Verify token; returns true if valid and not expired/revoked. */
export function verifyToken(token: string) {
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const record = tokenStore.get(hash);
  if (!record) return false;
  if (record.revoked) return false;
  if (Date.now() > record.expiresAt) return false;
  return true;
}

/** Revoke token so it cannot be used again. */
export function revokeToken(token: string) {
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const record = tokenStore.get(hash);
  if (record) {
    record.revoked = true;
  }
}
