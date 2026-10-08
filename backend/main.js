import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { settings } from "./config/settings.js";
import chatRouter from "./api/chat.js";
import {
  authenticateRequest,
  loginUser,
  logoutUser,
  setSessionCookie
} from "./auth/authentication.js";

const app = express();

// 1. CORS Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl)
      if (!origin) return callback(null, true);
      if (settings.allowOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive fallback matching previous config
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// 2. Parsers
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));

// 3. Public Paths
const PUBLIC_PATHS = new Set([
  "/",
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout"
]);

// 4. Authentication Middleware
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    try {
      authenticateRequest(req);
    } catch (err) {
      const status = err.statusCode || 401;
      return res.status(status).json({
        detail: err.message || "Authentication required."
      });
    }
  }

  return next();
});

// 5. Auth Routes
app.post("/api/auth/login", (req, res) => {
  try {
    const username = String(req.body?.username || "");
    const password = String(req.body?.password || "");

    const session = loginUser(username, password, res);

    return res.json({
      authenticated: true,
      token: session
    });
  } catch (err) {
    const status = err.statusCode || 401;
    return res.status(status).json({
      detail: err.message || "Invalid username or password."
    });
  }
});

app.get("/api/auth/me", (req, res) => {
  return res.json({
    authenticated: true
  });
});

app.post("/api/auth/logout", (req, res) => {
  logoutUser(res);
  return res.json({
    authenticated: false
  });
});

// 6. Chat and Graph Routes
app.use("/api", chatRouter);

// 7. Base and Health Routes
app.get("/", (req, res) => {
  return res.json({
    status: "ok",
    message: "Node.js Backend is running"
  });
});

app.get("/api/health", (req, res) => {
  return res.json({
    status: "healthy"
  });
});

import { fileURLToPath } from "url";
import { resolve } from "path";

// 8. Start server when run directly
const PORT = settings.port || 8000;
const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 CenarioCG Node.js backend listening on http://127.0.0.1:${PORT}`);
  });
}

export default app;
