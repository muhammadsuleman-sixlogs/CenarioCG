from __future__ import annotations

import re
from typing import Any


# ---------------------------------------------------------------------------
# Generic fields
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

# These can be useful for entity resolution, but should not automatically
# create structural cross-source joins.
ENTITY_COLUMNS = {
    "email",
    "phone",
    "website",
    "url",
    "slug",
}

# Canonical identifier suffixes.
IDENTIFIER_SUFFIXES = (
    "_id",
    "_uuid",
    "_key",
    "_code",
)

# Qualifiers that can appear after an identifier.
#
# Examples:
#
# project_id_display -> project_id
# project_id_name    -> project_id
# project_id_number  -> project_id
# project_id_ref     -> project_id
#
# These are semantic presentation/reference qualifiers, not new entities.
IDENTIFIER_QUALIFIERS = (
    "_display",
    "_display_id",
    "_display_value",
    "_name",
    "_number",
    "_no",
    "_num",
    "_ref",
    "_reference",
    "_value",
    "_label",
    "_text",
)

# Common wrappers that should be removed before comparing identifiers.
SEMANTIC_QUALIFIERS = {
    "display",
    "value",
    "label",
    "text",
    "number",
    "num",
    "no",
    "ref",
    "reference",
    "name",
}


# ---------------------------------------------------------------------------
# Name normalization
# ---------------------------------------------------------------------------

def _normalize(value: str) -> str:
    value = str(value).strip().lower()

    # camelCase -> snake_case
    value = re.sub(
        r"([a-z0-9])([A-Z])",
        r"\1_\2",
        value,
    )

    # Remove non-alphanumeric separators.
    value = re.sub(
        r"[^a-z0-9]+",
        "_",
        value,
    )

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


def _semantic_similarity(
    left: str,
    right: str,
) -> float:
    left_tokens = _semantic_tokens(left)
    right_tokens = _semantic_tokens(right)

    if not left_tokens or not right_tokens:
        return 0.0

    left_expanded: set[str] = set()
    right_expanded: set[str] = set()

    for token in left_tokens:
        left_expanded.update(
            _plural_variants(token)
        )

    for token in right_tokens:
        right_expanded.update(
            _plural_variants(token)
        )

    intersection = left_expanded.intersection(
        right_expanded
    )

    union = left_expanded.union(
        right_expanded
    )

    if not union:
        return 0.0

    return len(intersection) / len(union)


# ---------------------------------------------------------------------------
# Identifier normalization
# ---------------------------------------------------------------------------

def _strip_identifier_qualifiers(
    normalized: str,
) -> str:
    """
    Remove presentation/reference qualifiers that occur after a real
    identifier.

    Examples:

        project_id_display  -> project_id
        project_id_name     -> project_id
        project_id_ref      -> project_id
        project_id_number   -> project_id
    """

    value = normalized

    changed = True

    while changed:
        changed = False

        for qualifier in IDENTIFIER_QUALIFIERS:
            if value.endswith(qualifier):
                candidate = value[:-len(qualifier)].rstrip("_")

                if candidate:
                    value = candidate
                    changed = True
                    break

    return value


def _identifier_base(
    column_name: str,
) -> str | None:
    """
    Return the semantic entity represented by an identifier-like column.

    Examples:

        project_id
            -> project

        project_id_display
            -> project

        project_id_name
            -> project

        project_code
            -> project

        company_id
            -> company

        companion_epic_id
            -> companion_epic

        email
            -> None
    """

    normalized = _normalize(column_name)

    if not normalized:
        return None

    normalized = _strip_identifier_qualifiers(
        normalized
    )

    for suffix in IDENTIFIER_SUFFIXES:
        if normalized.endswith(suffix):
            base = normalized[:-len(suffix)].strip("_")

            if base:
                return base

    return None


def _canonical_identifier(
    column_name: str,
) -> str | None:
    """
    Return the canonical identifier family.

    Examples:

        project_id
            -> project

        project_id_display
            -> project

        project_code
            -> project

        user_uuid
            -> user
    """

    return _identifier_base(column_name)


def _is_identifier_column(
    column_name: str,
) -> bool:
    return (
        _identifier_base(column_name)
        is not None
    )


def _identifier_semantic_signature(
    column_name: str,
) -> set[str]:
    base = _identifier_base(column_name)

    if not base:
        return set()

    return _semantic_tokens(base)


# ---------------------------------------------------------------------------
# Column classification
# ---------------------------------------------------------------------------

def _is_generic_column(
    column_name: str,
) -> bool:
    normalized = _normalize(column_name)

    if normalized in GENERIC_COLUMNS:
        return True

    if normalized.endswith("_at"):
        return True

    if normalized.endswith("_date"):
        return True

    if normalized.endswith("_time"):
        return True

    return False


def _is_entity_column(
    column_name: str,
) -> bool:
    normalized = _normalize(column_name)

    if normalized in ENTITY_COLUMNS:
        return True

    for field in ENTITY_COLUMNS:
        if normalized.endswith(
            f"_{field}"
        ):
            return True

    return False


# ---------------------------------------------------------------------------
# Context metadata helpers
# ---------------------------------------------------------------------------

def _table_columns(
    context: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}

    tables = context.get(
        "tables",
        {},
    )

    if not isinstance(tables, dict):
        return result

    for table_name, table_info in tables.items():
        if not isinstance(table_info, dict):
            continue

        columns = table_info.get(
            "columns",
            [],
        )

        if not isinstance(columns, list):
            continue

        normalized_columns: list[dict[str, Any]] = []

        for column in columns:
            if isinstance(column, dict):
                normalized_columns.append(
                    column
                )

        result[str(table_name)] = normalized_columns

    return result


def _primary_keys(
    context: dict[str, Any],
) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}

    tables = context.get(
        "tables",
        {},
    )

    if not isinstance(tables, dict):
        return result

    for table_name, table_info in tables.items():
        if not isinstance(table_info, dict):
            continue

        primary_keys = table_info.get(
            "primary_keys",
            [],
        )

        if not isinstance(primary_keys, list):
            primary_keys = []

        result[str(table_name)] = {
            _normalize(column)
            for column in primary_keys
            if isinstance(column, str)
        }

    return result


def _foreign_key_columns(
    context: dict[str, Any],
) -> set[tuple[str, str]]:
    result: set[tuple[str, str]] = set()

    relationships = context.get(
        "relationships",
        [],
    )

    if not isinstance(relationships, list):
        return result

    for relationship in relationships:
        if not isinstance(relationship, dict):
            continue

        relationship_type = str(
            relationship.get(
                "relationship_type",
                "",
            )
        ).strip().upper()

        if relationship_type != "FOREIGN_KEY":
            continue

        source_table = relationship.get(
            "source_table"
        )
        source_column = relationship.get(
            "source_column"
        )

        if source_table and source_column:
            result.add(
                (
                    str(source_table),
                    _normalize(
                        str(source_column)
                    ),
                )
            )

    return result


def _column_type(
    table_columns: dict[str, list[dict[str, Any]]],
    table_name: str,
    column_name: str,
) -> str:
    normalized_column = _normalize(
        column_name
    )

    for column in table_columns.get(
        table_name,
        [],
    ):
        if not isinstance(column, dict):
            continue

        if (
            _normalize(
                str(column.get("name", ""))
            )
            == normalized_column
        ):
            return str(
                column.get(
                    "type",
                    "",
                )
            ).lower()

    return ""


# ---------------------------------------------------------------------------
# Type compatibility
# ---------------------------------------------------------------------------

def _normalized_type(
    data_type: str,
) -> str:
    value = str(
        data_type
    ).lower().strip()

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

    if (
        "boolean" in value
        or value == "bool"
    ):
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


def _types_compatible(
    left: str,
    right: str,
) -> bool:
    left_type = _normalized_type(
        left
    )
    right_type = _normalized_type(
        right
    )

    if not left_type or not right_type:
        return True

    if left_type == right_type:
        return True

    # uuid / integer identifiers are routinely stored as varchar/text in a
    # second system. The evidence check compares CAST(col AS text), so these
    # pairs are genuinely comparable and must not be penalised.
    text_castable = {"uuid", "integer"}

    if (
        left_type == "string" and right_type in text_castable
    ) or (
        right_type == "string" and left_type in text_castable
    ):
        return True

    return False


# ---------------------------------------------------------------------------
# Semantic entity matching
# ---------------------------------------------------------------------------

def _identifier_matches_table(
    identifier_base: str,
    table_name: str,
) -> bool:
    identifier_tokens = _semantic_tokens(
        identifier_base
    )

    table_tokens = _semantic_tokens(
        table_name
    )

    if not identifier_tokens or not table_tokens:
        return False

    identifier_expanded: set[str] = set()
    table_expanded: set[str] = set()

    for token in identifier_tokens:
        identifier_expanded.update(
            _plural_variants(token)
        )

    for token in table_tokens:
        table_expanded.update(
            _plural_variants(token)
        )

    return bool(
        identifier_expanded.intersection(
            table_expanded
        )
    )


def _same_identifier_semantics(
    left: str,
    right: str,
) -> bool:
    # BUGFIX: callers pass either a raw column name ("project_id") or an
    # already-derived base ("project"). _identifier_base() returns None for
    # a base that has no _id/_code suffix, which made this function (and
    # therefore _identifier_family_match) always return False.
    left_base = _identifier_base(left) or _normalize(left)
    right_base = _identifier_base(right) or _normalize(right)

    if not left_base or not right_base:
        return False

    left_tokens = _semantic_tokens(
        left_base
    )

    right_tokens = _semantic_tokens(
        right_base
    )

    if not left_tokens or not right_tokens:
        return False

    left_expanded: set[str] = set()
    right_expanded: set[str] = set()

    for token in left_tokens:
        left_expanded.update(
            _plural_variants(token)
        )

    for token in right_tokens:
        right_expanded.update(
            _plural_variants(token)
        )

    return bool(
        left_expanded.intersection(
            right_expanded
        )
    )


def _identifier_family_match(
    left_column: str,
    right_column: str,
) -> bool:
    """
    Stronger semantic identifier comparison.

    project_id
    project_id_display
    project_code

    all belong to the same semantic family: project.
    """

    left_base = _canonical_identifier(
        left_column
    )

    right_base = _canonical_identifier(
        right_column
    )

    if not left_base or not right_base:
        return False

    return _same_identifier_semantics(
        left_base,
        right_base,
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
    source_base: str | None = None,
    target_base: str | None = None,
) -> tuple[int, list[str], float]:
    score = 0
    evidence: list[str] = []

    # A primary key called "id" carries no entity name of its own; the
    # caller derives it from the table name and passes it in.
    source_base = source_base or _identifier_base(
        source_column
    )

    target_base = target_base or _identifier_base(
        target_column
    )

    table_similarity = _semantic_similarity(
        source_table,
        target_table,
    )

    # ---------------------------------------------------------
    # Canonical identifier family
    # ---------------------------------------------------------

    if _identifier_family_match(
        source_column,
        target_column,
    ):
        score += 7

        evidence.append(
            "Source and target columns belong to the same "
            "semantic identifier family"
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
            "Source and target tables have matching "
            "semantic tokens"
        )

    elif table_similarity >= 0.25:
        score += 1

        evidence.append(
            "Source and target tables have partial "
            "semantic overlap"
        )

    # ---------------------------------------------------------
    # FK -> PK
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
            "Source column participates in a foreign-key "
            "relationship"
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
        if (
            _is_identifier_column(source_column)
            and _is_identifier_column(target_column)
        ):
            score += 3

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
        # Type mismatch should reduce confidence, but should NOT
        # completely destroy a semantically strong candidate.
        #
        # This matters for real CRM systems where one source can
        # store an external identifier as varchar while another
        # stores the same conceptual identifier differently.
        score -= 3

        evidence.append(
            f"Data types differ: "
            f"{source_type} <-> {target_type}"
        )

    return (
        score,
        evidence,
        table_similarity,
    )


# ---------------------------------------------------------------------------
# Candidate generation
# ---------------------------------------------------------------------------

# Entity-level keys that are safe to compare across systems when the two
# tables represent the same entity (users.email <-> users.email).
ENTITY_KEY_COLUMNS = {"email", "website"}


def _entity_base(
    table_name: str,
    column_name: str,
    is_pk: bool,
) -> str | None:
    """
    Semantic entity represented by a column.

    - project_id / project_code / project_id_display -> "project"
    - a primary key called "id" -> the table's own entity (project_details)
    """

    base = _identifier_base(column_name)

    if base:
        return base

    if is_pk and _normalize(column_name) == "id":
        return _normalize(table_name)

    return None


def _is_child_of(
    table_name: str,
    fk_columns: set[tuple[str, str]],
    entity_table: str,
) -> bool:
    """
    True when the table holds a foreign key to the entity represented by
    entity_table (project_tasks has project_id -> it is a CHILD of the
    project entity, so its own "id" is not the project identifier).
    """

    for fk_table, fk_column in fk_columns:
        if fk_table != table_name:
            continue

        fk_base = _identifier_base(fk_column)

        if fk_base and _identifier_matches_table(
            fk_base,
            entity_table,
        ):
            return True

    return False


def find_cross_source_candidates(
    db1_context: dict[str, Any],
    db2_context: dict[str, Any],
) -> list[dict[str, Any]]:
    """
    Generate dynamic DB1 -> DB2 relationship candidates.

    Schema-driven and read-only. Nothing is hardcoded per database.

    Target side:
        Only "home key" columns are considered - the column that
        identifies the target table's OWN entity (projects.project_id,
        users.user_id, companies.id). Child columns such as
        epics.project_id are foreign keys to projects and are reached
        through projects, so they are not separate cross-source targets.

    Source side:
        - identifier columns (project_id, user_id, companion_epic_id ...)
        - primary keys named "id", treated as the table's own entity
          (project_details.id), unless the table is a child of the target
          entity (project_tasks.id is not a project identifier)
        - entity keys (email, website) when both tables are the same entity
    """

    db1_columns = _table_columns(db1_context)
    db2_columns = _table_columns(db2_context)

    db1_pks = _primary_keys(db1_context)
    db2_pks = _primary_keys(db2_context)

    db1_fks = _foreign_key_columns(db1_context)
    db2_fks = _foreign_key_columns(db2_context)

    candidates: list[dict[str, Any]] = []

    for source_table, source_columns in db1_columns.items():

        for source_info in source_columns:

            if not isinstance(source_info, dict):
                continue

            source_column = source_info.get("name")

            if not source_column:
                continue

            source_column = str(source_column)
            source_norm = _normalize(source_column)

            source_is_pk = source_norm in db1_pks.get(
                source_table,
                set(),
            )

            source_is_fk = (
                source_table,
                source_norm,
            ) in db1_fks

            source_is_pk_id = source_is_pk and source_norm == "id"
            source_is_entity_key = source_norm in ENTITY_KEY_COLUMNS

            if _is_generic_column(source_column) and not source_is_pk_id:
                continue

            if _is_entity_column(source_column) and not source_is_entity_key:
                continue

            source_base = _entity_base(
                source_table,
                source_column,
                source_is_pk,
            )

            if not source_base and not source_is_entity_key:
                continue

            source_type = _column_type(
                db1_columns,
                source_table,
                source_column,
            )

            for target_table, target_columns in db2_columns.items():

                table_similarity = _semantic_similarity(
                    source_table,
                    target_table,
                )

                same_semantic_table = table_similarity >= 0.5

                for target_info in target_columns:

                    if not isinstance(target_info, dict):
                        continue

                    target_column = target_info.get("name")

                    if not target_column:
                        continue

                    target_column = str(target_column)
                    target_norm = _normalize(target_column)

                    target_is_pk = target_norm in db2_pks.get(
                        target_table,
                        set(),
                    )

                    target_is_fk = (
                        target_table,
                        target_norm,
                    ) in db2_fks

                    target_is_pk_id = (
                        target_is_pk and target_norm == "id"
                    )

                    target_is_entity_key = (
                        target_norm in ENTITY_KEY_COLUMNS
                    )

                    if (
                        _is_generic_column(target_column)
                        and not target_is_pk_id
                    ):
                        continue

                    if (
                        _is_entity_column(target_column)
                        and not target_is_entity_key
                    ):
                        continue

                    # ------------------------------------------------
                    # Entity keys: same column name, same entity table
                    # ------------------------------------------------

                    if source_is_entity_key or target_is_entity_key:
                        if not (
                            source_is_entity_key
                            and target_is_entity_key
                            and source_norm == target_norm
                            and same_semantic_table
                        ):
                            continue

                        entity_key_pair = True
                        target_base = None
                    else:
                        entity_key_pair = False

                        target_base = _entity_base(
                            target_table,
                            target_column,
                            target_is_pk,
                        )

                        if not target_base:
                            continue

                        # Home-key rule: the target column must identify
                        # the target table's own entity.
                        if not _identifier_matches_table(
                            target_base,
                            target_table,
                        ):
                            continue

                    target_type = _column_type(
                        db2_columns,
                        target_table,
                        target_column,
                    )

                    # uuid <-> integer can never be the same identifier.
                    if not _types_compatible(source_type, target_type):
                        continue

                    # Integer surrogate keys (serial ids) are local to one
                    # database; only compare them with another integer key.
                    if (
                        _normalized_type(target_type) == "integer"
                        and _normalized_type(source_type) != "integer"
                    ):
                        continue

                    # ------------------------------------------------
                    # Primary-key "id" on the source side
                    # ------------------------------------------------

                    if source_is_pk_id and not entity_key_pair:
                        if not same_semantic_table:
                            continue

                        if _is_child_of(
                            source_table,
                            db1_fks,
                            target_table,
                        ):
                            continue

                    # ------------------------------------------------
                    # Semantic gate (identifier columns)
                    # ------------------------------------------------

                    if not entity_key_pair:
                        source_points_to_target = (
                            _identifier_matches_table(
                                source_base,
                                target_table,
                            )
                        )

                        target_points_to_source = (
                            _identifier_matches_table(
                                target_base,
                                source_table,
                            )
                        )

                        identifiers_match = (
                            _same_identifier_semantics(
                                source_base,
                                target_base,
                            )
                        )

                        identifier_family_match = (
                            identifiers_match
                        )

                        # A regular identifier column must itself point at
                        # the target entity. (The old rule also accepted a
                        # candidate when only the TARGET pointed back at the
                        # source table, which linked unrelated columns such
                        # as project_details.company_id -> projects.project_id.)
                        # Primary-key "id" sources were already matched to
                        # the target entity by the table-similarity check.
                        if not (
                            source_points_to_target
                            or identifiers_match
                            or source_is_pk_id
                        ):
                            continue
                    else:
                        source_points_to_target = True
                        target_points_to_source = True
                        identifiers_match = True
                        identifier_family_match = True

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
                        source_base=source_base,
                        target_base=target_base,
                    )

                    compatible_types = _types_compatible(
                        source_type,
                        target_type,
                    )

                    if entity_key_pair:
                        strength = "possible"
                        evidence.append(
                            "Entity key (same column on the same "
                            "entity table) - data evidence decides"
                        )
                    elif (
                        identifier_family_match
                        and source_points_to_target
                    ):
                        strength = "strong"
                    elif score >= 11:
                        strength = "strong"
                    elif score >= 7:
                        strength = "possible"
                    else:
                        continue

                    candidates.append(
                        {
                            "relationship_type": (
                                "CROSS_SOURCE_SEMANTIC"
                            ),
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
                            "identifier_family": source_base,
                            "identifier_family_match": (
                                identifier_family_match
                            ),
                            "compatible_types": compatible_types,
                            "evidence": evidence,
                        }
                    )

    # ------------------------------------------------------------------
    # Deduplicate
    # ------------------------------------------------------------------

    unique: dict[tuple[str, str, str, str], dict[str, Any]] = {}

    for candidate in candidates:

        key = (
            candidate["source_table"],
            candidate["source_column"],
            candidate["target_table"],
            candidate["target_column"],
        )

        previous = unique.get(key)

        if previous is None or candidate["score"] > previous["score"]:
            unique[key] = candidate

    candidates = list(unique.values())

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