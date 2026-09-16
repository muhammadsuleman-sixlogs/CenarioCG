from pipeline.rag_pipeline import RAGPipeline


class FakeAnswerGenerator:
    def __init__(self):
        self.received_question = None
        self.received_evidence = None

    def generate(self, question, evidence):
        self.received_question = question
        self.received_evidence = evidence
        return "test answer"


def test_pipeline_evidence_wiring():
    pipeline = RAGPipeline()

    fake_generator = FakeAnswerGenerator()
    pipeline.answer_generator = fake_generator

    evidence = pipeline.evidence_manager.prepare(
        retrieval={
            "rows": [
                {"id": 1, "name": "A"},
                {"id": 2, "name": "B"},
            ],
            "columns": ["id", "name"],
        },
        sources=[
            {
                "table": "example_table",
                "columns": ["id", "name"],
            }
        ],
    )

    answer = pipeline.answer_generator.generate(
        question="Test question",
        evidence=evidence,
    )

    assert answer == "test answer"
    assert fake_generator.received_question == "Test question"
    assert fake_generator.received_evidence == evidence

    assert fake_generator.received_evidence["row_count"] == 2
    assert fake_generator.received_evidence["total_retrieved"] == 2
    assert fake_generator.received_evidence["truncated"] is False

    print("Pipeline evidence wiring passed.")
    print("Evidence rows:", fake_generator.received_evidence["row_count"])
    print(
        "Total retrieved:",
        fake_generator.received_evidence["total_retrieved"],
    )


if __name__ == "__main__":
    test_pipeline_evidence_wiring()
    print("All pipeline wiring tests passed.")