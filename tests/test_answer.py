from llm.answer_generator import AnswerGenerator
from llm.evidence_manager import EvidenceManager


def test_answer_generator():
    generator = AnswerGenerator()
    evidence_manager = EvidenceManager()

    question = "Which records were created most recently?"

    retrieval = {
        "rows": [
            {
                "record_type": "example_table",
                "id": "1",
                "created_at": "2026-09-15",
            },
            {
                "record_type": "another_table",
                "id": "2",
                "created_at": "2026-09-14",
            },
        ],
        "row_count": 2,
        "columns": [
            "record_type",
            "id",
            "created_at",
        ],
    }

    sources = [
        {
            "source_type": "postgresql",
            "source": "postgresql",
            "entities": [
                "example_table",
                "another_table",
            ],
            "tables": [
                "example_table",
                "another_table",
            ],
            "columns": [
                "record_type",
                "id",
                "created_at",
            ],
            "query": "SELECT ...",
            "row_count": 2,
            "rows": retrieval["rows"],
        }
    ]

    evidence = evidence_manager.prepare(
        retrieval=retrieval,
        sources=sources,
    )

    prompt = generator.build_prompt(
        question=question,
        evidence=evidence,
    )

    assert isinstance(prompt, str)
    assert question in prompt
    assert "RETRIEVED EVIDENCE" in prompt
    assert "example_table" in prompt
    assert "created_at" in prompt
    assert evidence["row_count"] == 2
    assert evidence["total_retrieved"] == 2
    assert evidence["truncated"] is False

    print("Answer generator prompt preparation passed.")
    print("Evidence row count:", evidence["row_count"])
    print("Total retrieved:", evidence["total_retrieved"])
    print("No API call required.")


if __name__ == "__main__":
    test_answer_generator()
    print("All answer generator tests passed.")