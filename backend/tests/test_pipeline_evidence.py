from pipeline.rag_pipeline import RAGPipeline


def test_evidence_manager_integrated():
    pipeline = RAGPipeline()

    assert pipeline.evidence_manager is not None

    retrieval = {
        "columns": ["id", "name"],
        "rows": [
            {"id": i, "name": f"Record {i}"}
            for i in range(1, 101)
        ],
    }

    sources = [
        {
            "table": "example_table",
            "columns": ["id", "name"],
        }
    ]

    evidence = pipeline.evidence_manager.prepare(
        retrieval=retrieval,
        sources=sources,
    )

    assert len(evidence["rows"]) == 50
    assert evidence["row_count"] == 50
    assert evidence["total_retrieved"] == 100
    assert evidence["truncated"] is True

    assert evidence["columns"] == retrieval["columns"]

    assert "sources" in evidence
    assert evidence["sources"]

    print("Evidence row limit:", len(evidence["rows"]))
    print("Total retrieved:", evidence["total_retrieved"])
    print("Truncated:", evidence["truncated"])
    print("Evidence Manager integration passed.")


if __name__ == "__main__":
    test_evidence_manager_integrated()
    print("All pipeline evidence tests passed.")