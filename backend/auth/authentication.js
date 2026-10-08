import crypto from "crypto";
import { settings } from "../config/settings.js";

export const SESSION_COOKIE_NAME = "cenariocg_session";
export const SESSION_MAX_AGE = 60 * 60 * 8; // 8 hours in seconds

function getAuthConfig() {
  const username = settings.adminUsername;
  const password = settings.adminPassword;
  const secret = settings.authSecret;

  if (!username || !password || !secret) {
    throw new Error(
      "ADMIN_USERNAME, ADMIN_PASSWORD, and AUTH_SECRET must be configured."
    );
  }

  return { username, password, secret };
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signPayload(payload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
}

export function getCookieSettings() {
  const isSecure = Boolean(settings.cookieSecure);
  const sameSite = isSecure ? "none" : "lax";
  return { isSecure, sameSite };
}

export function createSession(username) {
  const { secret } = getAuthConfig();

  const payloadData = {
    username,
    expires_at: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  };

  const payload = Buffer.from(JSON.stringify(payloadData)).toString("base64url");
  const signature = signPayload(payload, secret);

  return `${payload}.${signature}`;
}

export function validateSession(session) {
  if (!session || typeof session !== "string") {
    return false;
  }

  const lastDot = session.lastIndexOf(".");
  if (lastDot === -1) {
    return false;
  }

  const payload = session.slice(0, lastDot);
  const signature = session.slice(lastDot + 1);

  try {
    const { secret } = getAuthConfig();
    const expectedSignature = signPayload(payload, secret);

    if (!safeCompare(signature, expectedSignature)) {
      return false;
    }

    // Support both base64url and standard base64 decoding
    let decodedStr;
    try {
      decodedStr = Buffer.from(payload, "base64url").toString("utf-8");
    } catch {
      decodedStr = Buffer.from(payload, "base64").toString("utf-8");
    }

    const data = JSON.parse(decodedStr);
    const expiresAt = parseInt(data.expires_at || 0, 10);

    if (expiresAt <= Math.floor(Date.now() / 1000)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function getSessionFromRequest(req) {
  if (!req) return null;

  const authHeader = req.headers
    ? req.headers["authorization"] || req.headers["Authorization"]
    : null;

  if (authHeader && typeof authHeader === "string") {
    const trimmed = authHeader.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx !== -1) {
      const scheme = trimmed.slice(0, spaceIdx).trim().toLowerCase();
      const token = trimmed.slice(spaceIdx + 1).trim();
      if (scheme === "bearer" && token) {
        return token;
      }
    } else if (trimmed.includes(".")) {
      return trimmed;
    }
  }

  if (req.cookies && req.cookies[SESSION_COOKIE_NAME]) {
    return req.cookies[SESSION_COOKIE_NAME];
  }

  return null;
}

export function setSessionCookie(res, session) {
  if (!res) return;
  const { isSecure, sameSite } = getCookieSettings();

  res.cookie(SESSION_COOKIE_NAME, session, {
    maxAge: SESSION_MAX_AGE * 1000,
    httpOnly: true,
    secure: isSecure,
    sameSite: sameSite,
    path: "/"
  });
}

export function authenticateRequest(req) {
  const session = getSessionFromRequest(req);
  if (!validateSession(session)) {
    const error = new Error("Authentication required.");
    error.statusCode = 401;
    error.status = 401;
    error.detail = "Authentication required.";
    throw error;
  }
}

export function loginUser(username, password, res = null) {
  const config = getAuthConfig();

  const isUserValid = safeCompare(username, config.username);
  const isPassValid = safeCompare(password, config.password);

  if (!isUserValid || !isPassValid) {
    const error = new Error("Invalid username or password.");
    error.statusCode = 401;
    error.status = 401;
    error.detail = "Invalid username or password.";
    throw error;
  }

  const session = createSession(username);

  if (res) {
    setSessionCookie(res, session);
  }

  return session;
}

export function logoutUser(res) {
  if (!res) return;
  const { isSecure, sameSite } = getCookieSettings();

  res.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    secure: isSecure,
    httpOnly: true,
    sameSite: sameSite
  });
}

export default {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  getCookieSettings,
  createSession,
  validateSession,
  getSessionFromRequest,
  setSessionCookie,
  authenticateRequest,
  loginUser,
  logoutUser
};

