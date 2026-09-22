import json
from pathlib import Path
from typing import Any

from database.connection import (
    get_connection,
    get_db2_connection,
)
from database.readonly_guard import validate_read_only_query
from retrieval.sql_validator import validate_sql_syntax
from context.cross_source_inference import (
    find_cross_source_candidates,
)
from context.context_builder import build_context


OUTPUT_FILE = Path("context/cross_source_evidence.json")


def _quote_identifier(value: str) -> str:
    """
    Safely quote a PostgreSQL identifier.

    Table and column names come from schema discovery / the
    internal candidate generator, but identifiers are still
    quoted
    before being inserted into generated SQL.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("SQL identifier cannot be empty.")

    return '"' + value.replace('"', '""') + '"'


def _get_connection(source_id: str):
    """
    Return the appropriate read-only PostgreSQL connection.
    """
    if source_id == "db1":
        connection = get_connection()
    elif source_id == "db2":
        connection = get_db2_connection()
    else:
        raise ValueError(f"Unknown source_id: {source_id}")

    # Defense in depth.
    # This does not modify database data; it makes the session
    # read-only as well.
    connection.set_session(readonly=True)

    return connection


def _build_hash_query(
    table_name: str,
    column_name: str,
) -> str:
    """
    Build a read-only query that returns distinct hashes of
    identifier values.

    Raw identifier values never leave PostgreSQL.
    """
    table_sql = _quote_identifier(table_name)
    column_sql = _quote_identifier(column_name)

    query = f"""
        SELECT DISTINCT
            md5(CAST({column_sql} AS text)) AS value_hash
        FROM {table_sql}
        WHERE {column_sql} IS NOT NULL
    """

    return query.strip()


def _load_identifier_hashes(
    source_id: str,
    table_name: str,
    column_name: str,
) -> dict[str, Any]:
    """
    Retrieve distinct identifier hashes from one source table/column.

    Returns only hashes and counts.
    Raw database values are never printed or returned.
    """
    query = _build_hash_query(
        table_name=table_name,
        column_name=column_name,
    )

    # Defense in depth: both validators must approve the query.
    validate_read_only_query(query)
    validate_sql_syntax(query)

    connection = _get_connection(source_id)

    try:
        with connection.cursor() as cursor:
            cursor.execute(query)
            rows = cursor.fetchall()

            hashes = {
                row[0]
                for row in rows
                if row and row[0]
            }

            return {
                "source_id": source_id,
                "table": table_name,
                "column": column_name,
                "distinct_count": len(hashes),
                "hashes": hashes,
            }

    finally:
        connection.close()


def _build_column_cache(
    candidates: list[dict[str, Any]],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """
    Load each unique source/table/column only once.

    Several candidates may use the same column, so this prevents
    unnecessary repeated database queries.
    """
    unique_columns: set[tuple[str, str, str]] = set()

    for candidate in candidates:
        source_id = candidate["source_system"]
        source_table = candidate["source_table"]
        source_column = candidate["source_column"]

        target_source_id = candidate["target_system"]
        target_table = candidate["target_table"]
        target_column = candidate["target_column"]

        unique_columns.add(
            (
                source_id,
                source_table,
                source_column,
            )
        )

        unique_columns.add(
            (
                target_source_id,
                target_table,
                target_column,
            )
        )

    print(
        f"Unique source columns to inspect: "
        f"{len(unique_columns)}"
    )

    cache: dict[
        tuple[str, str, str],
        dict[str, Any],
    ] = {}

    for index, (
        source_id,
        table_name,
        column_name,
    ) in enumerate(
        sorted(unique_columns),
        start=1,
    ):
        print(
            f"Reading identifier evidence "
            f"{index}/{len(unique_columns)}: "
            f"{source_id}:{table_name}.{column_name}"
        )

        key = (
            source_id,
            table_name,
            column_name,
        )

        try:
            cache[key] = _load_identifier_hashes(
                source_id=source_id,
                table_name=table_name,
                column_name=column_name,
            )

        except Exception as exc:
            cache[key] = {
                "source_id": source_id,
                "table": table_name,
                "column": column_name,
                "distinct_count": None,
                "hashes": None,
                "error": str(exc),
            }

            print(
                f"  ERROR: {type(exc).__name__}"
            )

    return cache


def _compare_candidate(
    candidate: dict[str, Any],
    cache: dict[
        tuple[str, str, str],
        dict[str, Any],
    ],
) -> dict[str, Any]:
    """
    Compare hashed identifiers for one cross-source candidate.
    """
    source_key = (
        candidate["source_system"],
        candidate["source_table"],
        candidate["source_column"],
    )

    target_key = (
        candidate["target_system"],
        candidate["target_table"],
        candidate["target_column"],
    )

    source_data = cache[source_key]
    target_data = cache[target_key]

    result = {
        "source_system": candidate["source_system"],
        "source_table": candidate["source_table"],
        "source_column": candidate["source_column"],
        "target_system": candidate["target_system"],
        "target_table": candidate["target_table"],
        "target_column": candidate["target_column"],
        "candidate_strength": candidate.get("strength"),
        "candidate_score": candidate.get("score"),
        "source_distinct_count": source_data.get(
            "distinct_count"
        ),
        "target_distinct_count": target_data.get(
            "distinct_count"
        ),
        "matching_identifier_count": None,
        "evidence_status": "error",
    }

    if source_data.get("error"):
        result["error"] = (
            f"Source query failed: "
            f"{source_data['error']}"
        )
        return result

    if target_data.get("error"):
        result["error"] = (
            f"Target query failed: "
            f"{target_data['error']}"
        )
        return result

    source_hashes = source_data["hashes"]
    target_hashes = target_data["hashes"]

    matching_hashes = (
        source_hashes & target_hashes
    )

    matching_count = len(matching_hashes)

    result["matching_identifier_count"] = (
        matching_count
    )

    if matching_count > 0:
        result["evidence_status"] = (
            "overlap_detected"
        )
    else:
        result["evidence_status"] = (
            "no_overlap"
        )

    return result


def collect_cross_source_evidence(
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Collect read-only identifier evidence for all candidates.
    """
    print()
    print("CROSS-SOURCE EVIDENCE")
    print("=" * 60)

    print(
        f"Candidates received: {len(candidates)}"
    )

    if not candidates:
        return {
            "candidates": [],
            "summary": {
                "total_candidates": 0,
                "overlap_detected": 0,
                "no_overlap": 0,
                "errors": 0,
            },
        }

    cache = _build_column_cache(candidates)

    results: list[dict[str, Any]] = []

    for index, candidate in enumerate(
        candidates,
        start=1,
    ):
        print()
        print(
            f"Candidate {index}/{len(candidates)}"
        )

        print(
            f"{candidate['source_system']}:"
            f"{candidate['source_table']}."
            f"{candidate['source_column']}"
        )

        print(
            " -> "
            f"{candidate['target_system']}:"
            f"{candidate['target_table']}."
            f"{candidate['target_column']}"
        )

        result = _compare_candidate(
            candidate,
            cache,
        )

        results.append(result)

        if result["evidence_status"] == (
            "error"
        ):
            print("Evidence: ERROR")

        else:
            print(
                "DB1/Source distinct identifiers: "
                f"{result['source_distinct_count']}"
            )

            print(
                "DB2/Target distinct identifiers: "
                f"{result['target_distinct_count']}"
            )

            print(
                "Matching identifiers: "
                f"{result['matching_identifier_count']}"
            )

            print(
                "Evidence: "
                f"{result['evidence_status']}"
            )

    overlap_count = sum(
        1
        for result in results
        if result["evidence_status"]
        == "overlap_detected"
    )

    no_overlap_count = sum(
        1
        for result in results
        if result["evidence_status"]
        == "no_overlap"
    )

    error_count = sum(
        1
        for result in results
        if result["evidence_status"]
        == "error"
    )

    report = {
        "candidates": results,
        "summary": {
            "total_candidates": len(results),
            "overlap_detected": overlap_count,
            "no_overlap": no_overlap_count,
            "errors": error_count,
        },
    }

    return report


def save_evidence_report(
    report: dict[str, Any],
) -> None:
    """
    Save evidence metadata to JSON.

    Raw identifiers and raw hashes are never saved.
    """
    OUTPUT_FILE.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with OUTPUT_FILE.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            report,
            file,
            indent=2,
        )


def run_cross_source_evidence() -> dict[str, Any]:
    """
    Build DB1/DB2 contexts, generate cross-source candidates,
    and perform the read-only evidence check.
    """
    print("Building DB1 context...")
    db1_context = build_context(source_id="db1")

    print("Building DB2 context...")
    db2_context = build_context(source_id="db2")

    print("Building cross-source candidates...")

    candidates = find_cross_source_candidates(
        db1_context,
        db2_context,
    )

    report = collect_cross_source_evidence(
        candidates
    )

    save_evidence_report(report)

    print()
    print("=" * 60)
    print("EVIDENCE SUMMARY")
    print("=" * 60)

    summary = report["summary"]

    print(
        f"Candidates: "
        f"{summary['total_candidates']}"
    )

    print(
        f"Overlap detected: "
        f"{summary['overlap_detected']}"
    )

    print(
        f"No overlap: "
        f"{summary['no_overlap']}"
    )

    print(
        f"Errors: "
        f"{summary['errors']}"
    )

    print(
        f"Saved to: {OUTPUT_FILE}"
    )

    return report


if __name__ == "__main__":
    run_cross_source_evidence()