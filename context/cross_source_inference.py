from __future__ import annotations

import re
from typing import Any


# ---------------------------------------------------------------------------
# Generic fields that should not create structural relationships
# ---------------------------------------------------------------------------

GENERIC_COLUMNS = {
    "id",
    "created_at",
    "updated_at",
    "deleted_at",
    "timestamp",
    "created",
    "date",
    "time",
    "title",
    "description",
    "name",
    "status",
    "priority",
    "type",
    "source",
}

# These are useful later for entity resolution, but they should not
# automatically become structural cross-source relationships.
ENTITY_COLUMNS = {
    "email",
    "phone",
    "website",
    "url",
    "slug",
}

IDENTIFIER_SUFFIXES = (
    "_id",
    "_uuid",
    "_key",
    "_code",
)


# ---------------------------------------------------------------------------
# Name normalization
# ---------------------------------------------------------------------------

def _normalize(value: str) -> str:
    value = str(value).strip().lower()

    # camelCase -> camel_case
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)

    # Remove non-alphanumeric separators.
    value = re.sub(r"[^a-z0-9]+", "_", value)

    return value.strip("_")


def _tokens(value: str) -> set[str]:
    normalized = _normalize(value)

    if not normalized:
        return set()

    return {
        token
        for token in normalized.split("_")
        if token
    }


def _semantic_tokens(value: str) -> set[str]:
    tokens = _tokens(value)

    ignored = {
        "id",
        "ids",
        "uuid",
        "key",
        "keys",
        "code",
        "codes",
        "data",
        "table",
    }

    return {
        token
        for token in tokens
        if token not in ignored
    }


def _plural_variants(token: str) -> set[str]:
    variants = {token}

    if token.endswith("ies") and len(token) > 3:
        variants.add(token[:-3] + "y")

    if token.endswith("s") and not token.endswith("ss") and len(token) > 2:
        variants.add(token[:-1])
    else:
        variants.add(token + "s")

    return variants


def _semantic_similarity(left: str, right: str) -> float:
    left_tokens = _semantic_tokens(left)
    right_tokens = _semantic_tokens(right)

    if not left_tokens or not right_tokens:
        return 0.0

    left_expanded = set()
    right_expanded = set()

    for token in left_tokens:
        left_expanded.update(_plural_variants(token))

    for token in right_tokens:
        right_expanded.update(_plural_variants(token))

    intersection = left_expanded.intersection(right_expanded)
    union = left_expanded.union(right_expanded)

    if not union:
        return 0.0

    return len(intersection) / len(union)


# ---------------------------------------------------------------------------
# Column classification
# ---------------------------------------------------------------------------

def _is_generic_column(column_name: str) -> bool:
    normalized = _normalize(column_name)

    if normalized in GENERIC_COLUMNS:
        return True

    # Generic temporal fields.
    if normalized.endswith("_at"):
        return True

    if normalized.endswith("_date"):
        return True

    if normalized.endswith("_time"):
        return True

    return False


def _is_entity_column(column_name: str) -> bool:
    normalized = _normalize(column_name)

    if normalized in ENTITY_COLUMNS:
        return True

    for field in ENTITY_COLUMNS:
        if normalized.endswith(f"_{field}"):
            return True

    return False


def _identifier_base(column_name: str) -> str | None:
    """
    Examples:

        project_id          -> project
        company_id          -> company
        companion_epic_id   -> companion_epic
        project_code        -> project
        email               -> None
    """

    normalized = _normalize(column_name)

    for suffix in IDENTIFIER_SUFFIXES:
        if normalized.endswith(suffix):
            base = normalized[:-len(suffix)].strip("_")

            if base:
                return base

    return None


def _is_identifier_column(column_name: str) -> bool:
    return _identifier_base(column_name) is not None


# ---------------------------------------------------------------------------
# Context metadata helpers
# ---------------------------------------------------------------------------

def _table_columns(
    context: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:

    return {
        table_name: table_info.get("columns", [])
        for table_name, table_info in context.get("tables", {}).items()
    }


def _primary_keys(
    context: dict[str, Any],
) -> dict[str, set[str]]:

    result = {}

    for table_name, table_info in context.get("tables", {}).items():
        result[table_name] = {
            _normalize(column)
            for column in table_info.get("primary_keys", [])
        }

    return result


def _foreign_key_columns(
    context: dict[str, Any],
) -> set[tuple[str, str]]:

    result = set()

    for relationship in context.get("relationships", []):

        if relationship.get("relationship_type") != "FOREIGN_KEY":
            continue

        source_table = relationship.get("source_table")
        source_column = relationship.get("source_column")

        if source_table and source_column:
            result.add(
                (
                    source_table,
                    _normalize(source_column),
                )
            )

    return result


def _column_type(
    table_columns: dict[str, list[dict[str, Any]]],
    table_name: str,
    column_name: str,
) -> str:

    normalized_column = _normalize(column_name)

    for column in table_columns.get(table_name, []):

        if _normalize(column.get("name", "")) == normalized_column:
            return str(column.get("type", "")).lower()

    return ""


# ---------------------------------------------------------------------------
# Type compatibility
# ---------------------------------------------------------------------------

def _normalized_type(data_type: str) -> str:

    value = str(data_type).lower().strip()

    if not value:
        return ""

    if "uuid" in value:
        return "uuid"

    if any(
        token in value
        for token in (
            "smallint",
            "integer",
            "bigint",
            "serial",
            "int",
        )
    ):
        return "integer"

    if any(
        token in value
        for token in (
            "character",
            "varchar",
            "text",
            "citext",
        )
    ):
        return "string"

    if "boolean" in value or value == "bool":
        return "boolean"

    if any(
        token in value
        for token in (
            "numeric",
            "decimal",
            "double",
            "real",
            "float",
        )
    ):
        return "numeric"

    if any(
        token in value
        for token in (
            "timestamp",
            "date",
            "time",
        )
    ):
        return "datetime"

    return value


def _types_compatible(left: str, right: str) -> bool:

    left_type = _normalized_type(left)
    right_type = _normalized_type(right)

    if not left_type or not right_type:
        return True

    if left_type == right_type:
        return True

    return False


# ---------------------------------------------------------------------------
# Semantic entity matching
# ---------------------------------------------------------------------------

def _identifier_matches_table(
    identifier_base: str,
    table_name: str,
) -> bool:

    identifier_tokens = _semantic_tokens(identifier_base)
    table_tokens = _semantic_tokens(table_name)

    if not identifier_tokens or not table_tokens:
        return False

    identifier_expanded = set()
    table_expanded = set()

    for token in identifier_tokens:
        identifier_expanded.update(
            _plural_variants(token)
        )

    for token in table_tokens:
        table_expanded.update(
            _plural_variants(token)
        )

    return bool(
        identifier_expanded.intersection(table_expanded)
    )


def _same_identifier_semantics(
    left: str,
    right: str,
) -> bool:

    left_tokens = _semantic_tokens(left)
    right_tokens = _semantic_tokens(right)

    if not left_tokens or not right_tokens:
        return False

    left_expanded = set()
    right_expanded = set()

    for token in left_tokens:
        left_expanded.update(
            _plural_variants(token)
        )

    for token in right_tokens:
        right_expanded.update(
            _plural_variants(token)
        )

    return bool(
        left_expanded.intersection(right_expanded)
    )


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------

def _build_evidence(
    source_table: str,
    source_column: str,
    target_table: str,
    target_column: str,
    source_is_pk: bool,
    target_is_pk: bool,
    source_is_fk: bool,
    target_is_fk: bool,
    source_type: str,
    target_type: str,
) -> tuple[int, list[str], float]:

    score = 0
    evidence = []

    source_base = _identifier_base(source_column)
    target_base = _identifier_base(target_column)

    table_similarity = _semantic_similarity(
        source_table,
        target_table,
    )

    # ---------------------------------------------------------
    # Source identifier -> target entity
    # ---------------------------------------------------------

    if source_base and _identifier_matches_table(
        source_base,
        target_table,
    ):
        score += 5

        evidence.append(
            f"{source_column} identifies the semantic entity "
            f"represented by target table {target_table}"
        )

    # ---------------------------------------------------------
    # Target identifier -> source entity
    # ---------------------------------------------------------

    if target_base and _identifier_matches_table(
        target_base,
        source_table,
    ):
        score += 2

        evidence.append(
            f"{target_column} identifies the semantic entity "
            f"represented by source table {source_table}"
        )

    # ---------------------------------------------------------
    # Identifier semantics
    # ---------------------------------------------------------

    if source_base and target_base:

        if _same_identifier_semantics(
            source_base,
            target_base,
        ):
            score += 4

            evidence.append(
                f"Identifier semantics match: "
                f"{source_column} <-> {target_column}"
            )

    # ---------------------------------------------------------
    # Table similarity
    # ---------------------------------------------------------

    if table_similarity >= 0.5:

        score += 2

        evidence.append(
            "Source and target tables have matching semantic tokens"
        )

    elif table_similarity >= 0.25:

        score += 1

        evidence.append(
            "Source and target tables have partial semantic overlap"
        )

    # ---------------------------------------------------------
    # FK -> PK is strong structural evidence
    # ---------------------------------------------------------

    if source_is_fk and target_is_pk:

        score += 4

        evidence.append(
            "Source column is a foreign key and target column "
            "is a primary key"
        )

    elif source_is_fk:

        score += 1

        evidence.append(
            "Source column participates in a foreign-key relationship"
        )

    if source_is_pk and target_is_fk:

        score += 1

        evidence.append(
            "Source column is a primary key and target column "
            "participates in a foreign-key relationship"
        )

    # ---------------------------------------------------------
    # Exact column match
    # ---------------------------------------------------------

    if (
        _normalize(source_column)
        == _normalize(target_column)
    ):

        # Exact name is useful only for identifier columns.
        if (
            _is_identifier_column(source_column)
            and _is_identifier_column(target_column)
        ):

            score += 2

            evidence.append(
                "Identifier column names match exactly"
            )

    # ---------------------------------------------------------
    # Type compatibility
    # ---------------------------------------------------------

    if _types_compatible(
        source_type,
        target_type,
    ):

        score += 2

        evidence.append(
            f"Compatible data types: "
            f"{source_type} <-> {target_type}"
        )

    else:

        score -= 5

        evidence.append(
            f"Data types differ: "
            f"{source_type} <-> {target_type}"
        )

    return score, evidence, table_similarity


# ---------------------------------------------------------------------------
# Candidate generation
# ---------------------------------------------------------------------------

def find_cross_source_candidates(
    db1_context: dict[str, Any],
    db2_context: dict[str, Any],
) -> list[dict[str, Any]]:
    """
    Generate schema-level DB1 -> DB2 relationship candidates.

    This function:

    - uses schema metadata only
    - does not query application rows
    - does not modify either database
    - does not hardcode company-specific entities
    - excludes ordinary attributes from structural matching
    - separates structural relationships from entity resolution
    - produces candidates for later LLM validation
    """

    db1_columns = _table_columns(db1_context)
    db2_columns = _table_columns(db2_context)

    db1_pks = _primary_keys(db1_context)
    db2_pks = _primary_keys(db2_context)

    db1_fks = _foreign_key_columns(db1_context)
    db2_fks = _foreign_key_columns(db2_context)

    candidates = []

    # ------------------------------------------------------------------
    # DB1 -> DB2
    # ------------------------------------------------------------------

    for source_table, source_columns in db1_columns.items():

        for source_info in source_columns:

            source_column = source_info.get("name")

            if not source_column:
                continue

            # Generic fields are not relationship candidates.
            if _is_generic_column(source_column):
                continue

            # Entity attributes are reserved for entity resolution.
            if _is_entity_column(source_column):
                continue

            source_base = _identifier_base(
                source_column
            )

            source_column_normalized = _normalize(
                source_column
            )

            source_is_pk = (
                source_column_normalized
                in db1_pks.get(
                    source_table,
                    set(),
                )
            )

            source_is_fk = (
                source_table,
                source_column_normalized,
            ) in db1_fks

            source_type = _column_type(
                db1_columns,
                source_table,
                source_column,
            )

            # Structural matching should normally start from an
            # identifier-like column.
            if not source_base:
                continue

            for target_table, target_columns in db2_columns.items():

                table_similarity = _semantic_similarity(
                    source_table,
                    target_table,
                )

                for target_info in target_columns:

                    target_column = target_info.get("name")

                    if not target_column:
                        continue

                    if _is_generic_column(target_column):
                        continue

                    if _is_entity_column(target_column):
                        continue

                    target_base = _identifier_base(
                        target_column
                    )

                    if not target_base:
                        continue

                    target_column_normalized = _normalize(
                        target_column
                    )

                    target_is_pk = (
                        target_column_normalized
                        in db2_pks.get(
                            target_table,
                            set(),
                        )
                    )

                    target_is_fk = (
                        target_table,
                        target_column_normalized,
                    ) in db2_fks

                    target_type = _column_type(
                        db2_columns,
                        target_table,
                        target_column,
                    )

                    # --------------------------------------------------
                    # Structural signal
                    # --------------------------------------------------

                    source_points_to_target = (
                        _identifier_matches_table(
                            source_base,
                            target_table,
                        )
                    )

                    identifiers_match = (
                        _same_identifier_semantics(
                            source_base,
                            target_base,
                        )
                    )

                    target_points_to_source = (
                        _identifier_matches_table(
                            target_base,
                            source_table,
                        )
                    )

                    same_semantic_table = (
                        table_similarity >= 0.5
                    )

                    # At least one meaningful structural relationship
                    # must exist.
                    if not (
                        source_points_to_target
                        or identifiers_match
                        or target_points_to_source
                        or (
                            same_semantic_table
                            and source_is_pk
                            and target_is_pk
                        )
                    ):
                        continue

                    (
                        score,
                        evidence,
                        computed_similarity,
                    ) = _build_evidence(
                        source_table=source_table,
                        source_column=source_column,
                        target_table=target_table,
                        target_column=target_column,
                        source_is_pk=source_is_pk,
                        target_is_pk=target_is_pk,
                        source_is_fk=source_is_fk,
                        target_is_fk=target_is_fk,
                        source_type=source_type,
                        target_type=target_type,
                    )

                    # --------------------------------------------------
                    # Important type rule
                    #
                    # Do not call incompatible identifiers "strong".
                    # A UUID project identifier and a varchar project
                    # code may represent related concepts, but that is
                    # something the LLM must validate.
                    # --------------------------------------------------

                    compatible_types = _types_compatible(
                        source_type,
                        target_type,
                    )

                    # Exact identifier match with incompatible types
                    # is possible but should only be a possible candidate.
                    if not compatible_types:

                        if score < 8:
                            continue

                        strength = "possible"

                    else:

                        # Strong requires multiple structural signals.
                        if score >= 11:
                            strength = "strong"
                        elif score >= 8:
                            strength = "possible"
                        else:
                            continue

                    # --------------------------------------------------
                    # Prevent weak same-table attribute -> identifier
                    # matches.
                    #
                    # Example:
                    # users.first_name -> users.user_id
                    #
                    # Both tables being named "users" is not enough.
                    # --------------------------------------------------

                    if (
                        same_semantic_table
                        and not source_is_pk
                        and not source_is_fk
                        and not identifiers_match
                    ):
                        continue

                    candidate = {
                        "source_system": "db1",
                        "target_system": "db2",
                        "source_table": source_table,
                        "source_column": source_column,
                        "target_table": target_table,
                        "target_column": target_column,
                        "strength": strength,
                        "score": score,
                        "table_similarity": round(
                            computed_similarity,
                            3,
                        ),
                        "semantic_similarity": round(
                            computed_similarity,
                            3,
                        ),
                        "source_column_type": source_type,
                        "target_column_type": target_type,
                        "source_is_primary_key": source_is_pk,
                        "target_is_primary_key": target_is_pk,
                        "source_is_foreign_key": source_is_fk,
                        "target_is_foreign_key": target_is_fk,
                        "evidence": evidence,
                    }

                    candidates.append(candidate)

    # ------------------------------------------------------------------
    # Deduplicate
    # ------------------------------------------------------------------

    unique = {}

    for candidate in candidates:

        key = (
            candidate["source_table"],
            candidate["source_column"],
            candidate["target_table"],
            candidate["target_column"],
        )

        previous = unique.get(key)

        if previous is None:
            unique[key] = candidate

        elif candidate["score"] > previous["score"]:
            unique[key] = candidate

    candidates = list(unique.values())

    # ------------------------------------------------------------------
    # Sort strongest candidates first
    # ------------------------------------------------------------------

    candidates.sort(
        key=lambda candidate: (
            0 if candidate["strength"] == "strong" else 1,
            -candidate["score"],
            -candidate["table_similarity"],
            candidate["source_table"],
            candidate["source_column"],
            candidate["target_table"],
            candidate["target_column"],
        )
    )

    return candidates