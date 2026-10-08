import { test } from "node:test";
import assert from "node:assert";
import {
  createSession,
  validateSession,
  loginUser,
  authenticateRequest,
  getSessionFromRequest,
  getCookieSettings
} from "../auth/authentication.js";

test("Authentication creates and validates tamper-proof HMAC sessions", () => {
  const session = createSession("admin");
  assert.ok(session.includes("."));
  assert.strictEqual(validateSession(session), true);
});

test("Authentication rejects tampered tokens", () => {
  const session = createSession("admin");
  const tampered = session.slice(0, -3) + "xyz";
  assert.strictEqual(validateSession(tampered), false);
});

test("Authentication rejects null or empty tokens", () => {
  assert.strictEqual(validateSession(null), false);
  assert.strictEqual(validateSession(""), false);
  assert.strictEqual(validateSession("invalid-token"), false);
  assert.strictEqual(validateSession(12345), false);
});

test("getSessionFromRequest extracts Bearer token, multi-space Bearer, and raw dot tokens", () => {
  const req1 = { headers: { authorization: "Bearer my-valid-token" } };
  assert.strictEqual(getSessionFromRequest(req1), "my-valid-token");

  const req2 = { headers: { authorization: "Bearer    multi-spaced-token" } };
  assert.strictEqual(getSessionFromRequest(req2), "multi-spaced-token");

  const req3 = { headers: { authorization: "raw.token.value" } };
  assert.strictEqual(getSessionFromRequest(req3), "raw.token.value");

  const req4 = { headers: {}, cookies: { cenariocg_session: "cookie-token" } };
  assert.strictEqual(getSessionFromRequest(req4), "cookie-token");

  const req5 = { headers: {}, cookies: {} };
  assert.strictEqual(getSessionFromRequest(req5), null);
});

test("loginUser safely rejects wrong length passwords without throwing RangeError", () => {
  assert.throws(
    () => loginUser("admin", "wrong"),
    (err) => err.statusCode === 401 && err.detail === "Invalid username or password."
  );

  assert.throws(
    () => loginUser("admin", ""),
    (err) => err.statusCode === 401
  );

  assert.throws(
    () => loginUser("", "sixlogs@CE2026"),
    (err) => err.statusCode === 401
  );
});

test("authenticateRequest throws 401 with detail 'Authentication required.' on invalid session", () => {
  const req = { headers: { authorization: "Bearer invalid.signature" } };
  assert.throws(
    () => authenticateRequest(req),
    (err) => err.statusCode === 401 && err.detail === "Authentication required."
  );
});

test("getCookieSettings returns appropriate flags", () => {
  const { isSecure, sameSite } = getCookieSettings();
  assert.strictEqual(typeof isSecure, "boolean");
  assert.ok(["none", "lax"].includes(sameSite));
});

