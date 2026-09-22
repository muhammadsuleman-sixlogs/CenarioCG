from typing import Any


def get_known_tables(
    context: dict[str, Any],
) -> set[str]:
    return set(
        context.get("tables", {}).keys()
    )


def get_known_columns(
    context: dict[str, Any],
) -> dict[str, set[str]]:
    known_columns: dict[str, set[str]] = {}

    for table_name, table_info in context.get(
        "tables",
        {},
    ).items():
        known_columns[table_name] = {
            column["name"]
            for column in table_info.get(
                "columns",
                [],
            )
        }

    return known_columns


def get_known_foreign_keys(
    context: dict[str, Any],
) -> set[tuple[str, str, str, str]]:
    return {
        (
            relationship["source_table"],
            relationship["source_column"],
            relationship["target_table"],
            relationship["target_column"],
        )
        for relationship in context.get(
            "relationships",
            [],
        )
    }


def validate_source_id(
    relationship: dict[str, Any],
    context: dict[str, Any],
) -> tuple[bool, str]:
    """
    Validate that the relationship belongs to the
    context source being validated.
    """

    context_source_id = context.get(
        "source_id",
        "db1",
    )

    relationship_source_id = relationship.get(
        "source_id"
    )

    if not relationship_source_id:
        return (
            False,
            "Missing source_id.",
        )

    if relationship_source_id != context_source_id:
        return (
            False,
            "Relationship source_id does not match "
            "the supplied context source.",
        )

    return True, "Source ID is valid."


def validate_confidence(
    relationship: dict[str, Any],
) -> tuple[bool, str]:
    confidence = relationship.get(
        "confidence"
    )

    if not isinstance(
        confidence,
        (int, float),
    ):
        return (
            False,
            "Confidence must be numeric.",
        )

    if not 0 <= confidence <= 1:
        return (
            False,
            "Confidence must be between 0 and 1.",
        )

    return True, "Confidence is valid."


def validate_evidence(
    relationship: dict[str, Any],
) -> tuple[bool, str]:
    evidence = relationship.get(
        "evidence"
    )

    if not evidence:
        return (
            False,
            "Relationship must contain evidence.",
        )

    if not isinstance(
        evidence,
        list,
    ):
        return (
            False,
            "Evidence must be a list.",
        )

    valid_evidence = [
        item
        for item in evidence
        if isinstance(item, str)
        and item.strip()
    ]

    if not valid_evidence:
        return (
            False,
            "Relationship evidence cannot be empty.",
        )

    return True, "Evidence is valid."


def validate_relationship(
    relationship: dict[str, Any],
    context: dict[str, Any],
) -> tuple[bool, str]:

    source_valid, source_reason = (
        validate_source_id(
            relationship,
            context,
        )
    )

    if not source_valid:
        return False, source_reason

    known_tables = get_known_tables(
        context
    )

    known_columns = get_known_columns(
        context
    )

    source_table = relationship.get(
        "source_table"
    )

    target_table = relationship.get(
        "target_table"
    )

    if not source_table:
        return (
            False,
            "Missing source_table.",
        )

    if not target_table:
        return (
            False,
            "Missing target_table.",
        )

    if source_table not in known_tables:
        return (
            False,
            f"Unknown source table: {source_table}",
        )

    if target_table not in known_tables:
        return (
            False,
            f"Unknown target table: {target_table}",
        )

    confidence_valid, confidence_reason = (
        validate_confidence(
            relationship
        )
    )

    if not confidence_valid:
        return False, confidence_reason

    evidence_valid, evidence_reason = (
        validate_evidence(
            relationship
        )
    )

    if not evidence_valid:
        return False, evidence_reason

    source_column = relationship.get(
        "source_column"
    )

    target_column = relationship.get(
        "target_column"
    )

    if source_column:
        if source_column not in known_columns[
            source_table
        ]:
            return (
                False,
                f"Unknown source column: "
                f"{source_table}.{source_column}",
            )

    if target_column:
        if target_column not in known_columns[
            target_table
        ]:
            return (
                False,
                f"Unknown target column: "
                f"{target_table}.{target_column}",
            )

    return True, "Relationship is valid."


def validate_relationships(
    relationships: list[dict[str, Any]],
    context: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:

    valid = []
    invalid = []

    for relationship in relationships:

        is_valid, reason = (
            validate_relationship(
                relationship,
                context,
            )
        )

        if is_valid:
            valid.append(
                relationship
            )
        else:
            invalid.append(
                {
                    "relationship": relationship,
                    "reason": reason,
                }
            )

    return {
        "valid": valid,
        "invalid": invalid,
    }