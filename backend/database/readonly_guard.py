import re


READ_ONLY_PATTERN = re.compile(
    r"^\s*(SELECT|WITH)\b",
    re.IGNORECASE,
)


BLOCKED_KEYWORDS = re.compile(
    r"\b("
    r"INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|"
    r"GRANT|REVOKE|VACUUM|REINDEX|REFRESH|"
    r"MERGE|CALL|DO|LOCK"
    r")\b",
    re.IGNORECASE,
)


BLOCKED_COMMENT_PATTERN = re.compile(
    r"\bCOMMENT\s+ON\b",
    re.IGNORECASE,
)


FOR_UPDATE_PATTERN = re.compile(
    r"\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b",
    re.IGNORECASE,
)


TRANSACTION_PATTERN = re.compile(
    r"\b("
    r"BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|"
    r"SAVEPOINT|RELEASE\s+SAVEPOINT"
    r")\b",
    re.IGNORECASE,
)


def _remove_comments(query: str) -> str:
    """
    Remove SQL comments before validation.
    """

    query = re.sub(
        r"/\*.*?\*/",
        " ",
        query,
        flags=re.DOTALL,
    )

    query = re.sub(
        r"--[^\n]*",
        " ",
        query,
    )

    return query


def _has_multiple_statements(query: str) -> bool:
    """
    Reject multiple SQL statements.

    A trailing semicolon is allowed, but another
    statement after it is not.
    """

    stripped = query.strip()

    if ";" not in stripped:
        return False

    without_trailing_semicolon = stripped.rstrip(";").strip()

    return ";" in without_trailing_semicolon


def validate_read_only_query(query: str) -> None:
    """
    Allow only read-only SELECT/WITH SQL.

    This is an application-level safety guard.
    PostgreSQL should still use a dedicated read-only
    database account as the primary protection.

    Raises ValueError for anything that could perform
    a write, schema change, locking operation, or
    transaction-control operation.
    """

    if not query or not query.strip():
        raise ValueError("Query cannot be empty.")

    query = _remove_comments(query).strip()

    if not READ_ONLY_PATTERN.match(query):
        raise ValueError(
            "Blocked: only SELECT/WITH queries are allowed."
        )

    if _has_multiple_statements(query):
        raise ValueError(
            "Blocked: multiple SQL statements are not allowed."
        )

    if BLOCKED_KEYWORDS.search(query):
        raise ValueError(
            "Blocked: query contains a forbidden database operation."
        )

    if BLOCKED_COMMENT_PATTERN.search(query):
        raise ValueError(
            "Blocked: COMMENT ON statements are not allowed."
        )

    if FOR_UPDATE_PATTERN.search(query):
        raise ValueError(
            "Blocked: row-locking queries are not allowed."
        )

    if TRANSACTION_PATTERN.search(query):
        raise ValueError(
            "Blocked: transaction-control statements are not allowed."
        )