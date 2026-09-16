SENSITIVE_COLUMN_NAMES = {
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
    "share_password_hash",
}


def is_sensitive_column(column_name: str) -> bool:
    name = column_name.lower()

    if name in SENSITIVE_COLUMN_NAMES:
        return True

    sensitive_patterns = (
        "password",
        "private_key",
        "secret",
        "token",
        "api_key",
    )

    return any(pattern in name for pattern in sensitive_patterns)