from __future__ import annotations

import re
from typing import Any

"""
Output security policy for the Context Layer.

Purpose:
- Prevent credential-like values from being returned to users.
- Provide a final defense before an LLM answer is returned.
- Keep the policy generic and independent of company schema.

This module does not access or modify any database.
"""

# Generic patterns for values that should never be exposed.
#
# These patterns intentionally target credential-like structures
# rather than ordinary business values.
SENSITIVE_VALUE_PATTERNS = (
    # Bearer tokens
    re.compile(
        r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}",
        re.IGNORECASE,
    ),
    # Common secret/token assignments
    re.compile(
        r"\b(?:password|passwd|passcode|secret|api[_-]?key|"
        r"access[_-]?token|refresh[_-]?token|auth[_-]?token|"
        r"bearer[_-]?token|client[_-]?secret|credential)"
        r"\s*[:=]\s*[^\s,;]+",
        re.IGNORECASE,
    ),
    # Private key blocks
    re.compile(
        r"-----BEGIN\s+(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
        r".*?"
        r"-----END\s+(?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        re.IGNORECASE | re.DOTALL,
    ),
)


def contains_sensitive_value(value: Any) -> bool:
    """
    Return True if a value contains a credential-like pattern.
    """

    if not isinstance(value, str):
        return False

    return any(
        pattern.search(value)
        for pattern in SENSITIVE_VALUE_PATTERNS
    )


def sanitize_output_text(text: Any) -> str:
    """
    Remove credential-like values from text before it is returned
    to the user.

    This is a final output safety layer.

    It does not attempt to determine whether ordinary business
    data is sensitive.
    """

    if text is None:
        return ""

    if not isinstance(text, str):
        text = str(text)

    sanitized = text

    for pattern in SENSITIVE_VALUE_PATTERNS:
        sanitized = pattern.sub(
            "[REDACTED]",
            sanitized,
        )

    return sanitized


def validate_output_text(text: Any) -> None:
    """
    Reject output containing credential-like values.

    This function is intentionally stricter than sanitization and
    should be used when the application wants to fail closed.
    """

    if contains_sensitive_value(text):
        raise ValueError(
            "The generated response contains sensitive or "
            "credential-like information and cannot be returned."
        )


def sanitize_sensitive_values(value: Any) -> Any:
    """
    Recursively sanitize credential-like values inside nested
    dictionaries, lists, tuples, and strings.

    Normal business data is preserved.

    This function does not access or modify any database.
    """

    if isinstance(value, str):
        return sanitize_output_text(value)

    if isinstance(value, dict):
        return {
            key: sanitize_sensitive_values(item)
            for key, item in value.items()
        }

    if isinstance(value, list):
        return [
            sanitize_sensitive_values(item)
            for item in value
        ]

    if isinstance(value, tuple):
        return tuple(
            sanitize_sensitive_values(item)
            for item in value
        )

    return value


def sanitize_evidence(
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """
    Sanitize retrieved evidence before it is supplied to the LLM.

    This is especially important for security/SIEM data because
    sensitive values may appear inside arbitrary log fields or
    message text.
    """

    if not isinstance(evidence, dict):
        return {}

    sanitized = sanitize_sensitive_values(evidence)

    if not isinstance(sanitized, dict):
        return {}

    return sanitized


def sanitize_api_response(
    response: dict[str, Any],
) -> dict[str, Any]:
    """
    Sanitize the final API response before it is returned to the
    frontend or another API consumer.

    This prevents raw retrieval payloads from bypassing the
    LLM output-security layer.
    """

    if not isinstance(response, dict):
        return {}

    sanitized = sanitize_sensitive_values(response)

    if not isinstance(sanitized, dict):
        return {}

    return sanitized