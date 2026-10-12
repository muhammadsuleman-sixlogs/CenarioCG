import crypto from "crypto";

export function createRequestId() {
  return crypto.randomUUID();
}

export function classifyRuntimeError(error) {
  const code = String(error?.code || "").toUpperCase();
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();

  if (code === "MISSING_SOURCE_ID" || code === "UNSUPPORTED_SOURCE_ID" || /source_id.*(required|empty|non-empty)|unsupported postgresql source/i.test(message)) return "missing_source_id";
  if (code === "SQL_VALIDATION_ERROR" || name.includes("sql") || /read[- ]only|sql syntax|unsafe sql|forbidden sql|mutation/i.test(lower)) return "sql_validation_error";
  if (["EACCES", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND"].includes(code) || /connect eacces|connection refused|connection reset|timed out|network is unreachable|no route to host|could not resolve host/i.test(lower)) return "network_failure";
  if (["28P01", "28000", "AUTHENTICATION_FAILED"].includes(code) || /password authentication failed|authentication failed|invalid password|not authorized/i.test(lower)) return "database_authentication_failure";
  return "query_execution_error";
}

export function diagnosticRecord(error, { requestId = null, sourceId = null, stepId = null, phase = "runtime" } = {}) {
  return {
    request_id: requestId || null,
    phase,
    category: classifyRuntimeError(error),
    source_id: typeof sourceId === "string" && sourceId.trim() ? sourceId.trim().toLowerCase() : null,
    step_id: typeof stepId === "string" && stepId.trim() ? stepId.trim() : null,
    error_code: error?.code ? String(error.code) : null,
    error_name: error?.name ? String(error.name) : "Error",
    message: String(error?.message || error || "")
  };
}

export function logRuntimeDiagnostic(error, options = {}) {
  const record = diagnosticRecord(error, options);
  const output = `RUNTIME DIAGNOSTIC ${JSON.stringify(record)}`;
  if (record.category === "network_failure" || record.category === "database_authentication_failure") console.warn(output);
  else console.error(output);
  return record;
}

export default { createRequestId, classifyRuntimeError, diagnosticRecord, logRuntimeDiagnostic };
