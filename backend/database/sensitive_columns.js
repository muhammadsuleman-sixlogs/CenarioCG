export const SENSITIVE_COLUMN_NAMES = new Set([
  "password",
  "password_hash",
  "token",
  "token_hash",
  "private_key",
  "secret",
  "secret_key",
  "api_key",
  "two_factor_code",
  "stripe_payment_intent_id",
  "stripe_invoice_id",
  "stripe_customer_id",
  "stripe_connect_account_id",
  "share_password_hash"
]);

export function isSensitiveColumn(columnName) {
  if (!columnName || typeof columnName !== "string") {
    return false;
  }
  const name = columnName.toLowerCase();

  if (SENSITIVE_COLUMN_NAMES.has(name)) {
    return true;
  }

  const sensitivePatterns = [
    "password",
    "private_key",
    "secret",
    "token",
    "api_key"
  ];

  return sensitivePatterns.some(pattern => name.includes(pattern));
}

export const is_sensitive_column = isSensitiveColumn;

export default {
  SENSITIVE_COLUMN_NAMES,
  isSensitiveColumn,
  is_sensitive_column
};

