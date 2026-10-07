from llm.evidence_manager import EvidenceManager


def test_evidence_manager():
    manager = EvidenceManager(max_rows=3)

    retrieval = {
        "rows": [
            {"id": 1},
            {"id": 2},
            {"id": 3},
            {"id": 4},
            {"id": 5},
        ],
        "columns": ["id"],
        "row_count": 5,
    }

    sources = [
        {
            "source": "postgresql",
            "tables": ["example_table"],
            "columns": ["id"],
            "rows": retrieval["rows"],
        }
    ]

    evidence = manager.prepare(
        retrieval=retrieval,
        sources=sources,
    )

    assert len(evidence["rows"]) == 3
    assert evidence["row_count"] == 3
    assert evidence["total_retrieved"] == 5
    assert evidence["truncated"] is True
    assert len(evidence["sources"][0]["rows"]) == 3

    print("Evidence rows:", len(evidence["rows"]))
    print("Total retrieved:", evidence["total_retrieved"])
    print("Truncated:", evidence["truncated"])
    print("Evidence manager test passed.")


if __name__ == "__main__":
    test_evidence_manager()