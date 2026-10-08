import { test } from "node:test";
import assert from "node:assert";
import {
  isSensitiveFieldName,
  isSensitiveFieldReference,
  isSensitiveQuestionIntent,
  sanitizeSchemaContext
} from "../security/sensitive_data_policy.js";
import {
  sanitizeOutputText,
  containsSensitiveValue
} from "../security/output_security_policy.js";

test("Sensitive field detection identifies credential column patterns", () => {
  assert.strictEqual(isSensitiveFieldName("password"), true);
  assert.strictEqual(isSensitiveFieldName("password_hash"), true);
  assert.strictEqual(isSensitiveFieldName("api_key"), true);
  assert.strictEqual(isSensitiveFieldName("client_secret"), true);
  assert.strictEqual(isSensitiveFieldName("auth_token"), true);

  assert.strictEqual(isSensitiveFieldName("username"), false);
  assert.strictEqual(isSensitiveFieldName("email"), false);
  assert.strictEqual(isSensitiveFieldName("project_id"), false);
});

test("Sensitive question intent detects queries requesting passwords or secrets", () => {
  assert.strictEqual(isSensitiveQuestionIntent("what is the admin password?"), true);
  assert.strictEqual(isSensitiveQuestionIntent("give me user tokens"), true);
  assert.strictEqual(isSensitiveQuestionIntent("show me the secret key"), true);
  assert.strictEqual(isSensitiveQuestionIntent("list user passwords and credentials"), true);

  assert.strictEqual(isSensitiveQuestionIntent("show me recent projects"), false);
  assert.strictEqual(isSensitiveQuestionIntent("how many tasks were completed?"), false);
  assert.strictEqual(isSensitiveQuestionIntent("what meeting transcripts are available?"), false);
});

test("Output sanitizer redacts Bearer tokens and passwords in text", () => {
  const textWithBearer = "The token is Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz";
  const redacted = sanitizeOutputText(textWithBearer);
  assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
  assert.ok(redacted.includes("[REDACTED]"));

  const textWithPass = "password: SuperSecretPassword123!";
  const passRedacted = sanitizeOutputText(textWithPass);
  assert.ok(!passRedacted.includes("SuperSecretPassword123!"));
  assert.ok(passRedacted.includes("[REDACTED]"));
});

test("SanitizeSchemaContext removes sensitive columns from schema context", () => {
  const schema = {
    tables: {
      users: {
        columns: [
          { name: "id", type: "uuid" },
          { name: "email", type: "text" },
          { name: "password", type: "text" },
          { name: "api_key", type: "text" }
        ]
      }
    }
  };

  const sanitized = sanitizeSchemaContext(schema);
  const userCols = sanitized.tables.users.columns.map(c => c.name);
  assert.deepStrictEqual(userCols, ["id", "email"]);
});
