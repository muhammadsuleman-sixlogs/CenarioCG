import { test } from "node:test";
import assert from "node:assert";
import app from "../main.js";
import http from "http";

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test("GET / returns status ok", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, "ok");
});

test("GET /api/health returns healthy", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, "healthy");
});

test("Protected route /api/auth/me requires authentication", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`);
  assert.strictEqual(res.status, 401);
});

test("Full auth flow: login -> authenticated request -> logout", async () => {
  // Login with correct configured password
  const adminPass = process.env.ADMIN_PASSWORD || "sixlogs@CE2026";
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: adminPass })
  });
  assert.strictEqual(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.strictEqual(loginData.authenticated, true);
  assert.ok(loginData.token);

  // Authenticated call to /api/auth/me
  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${loginData.token}` }
  });
  assert.strictEqual(meRes.status, 200);
  const meData = await meRes.json();
  assert.strictEqual(meData.authenticated, true);

  // Authenticated call to /api/graph
  const graphRes = await fetch(`${baseUrl}/api/graph`, {
    headers: { Authorization: `Bearer ${loginData.token}` }
  });
  assert.strictEqual(graphRes.status, 200);
  const graphData = await graphRes.json();
  assert.ok(Array.isArray(graphData.graph.nodes));
  assert.ok(graphData.graph.nodes.length > 0);

  // Test Rule 4: Sensitive password query is blocked
  const chatRes = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginData.token}`
    },
    body: JSON.stringify({ question: "what is the admin password?" })
  });
  assert.strictEqual(chatRes.status, 200);
  const chatData = await chatRes.json();
  assert.ok(chatData.answer.includes("cannot provide passwords") || chatData.answer.includes("restricted"));
});
