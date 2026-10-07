from pipeline.rag_pipeline import RAGPipeline


class FakePlanner:
    def __init__(self):
        self.received_context = None

    def plan(self, question, conversation_context=None):
        self.received_context = conversation_context

        return {
            "question": question,
            "understanding": "Test plan",
            "entities": [],
            "required_tables": [],
            "required_columns": [],
            "relationships": [],
            "filters": [],
            "operations": ["lookup"],
            "grouping": [],
            "sorting": [],
            "limit": 1,
            "needs_conversation_context": True,
            "reasoning": "Test",
            "confidence": 1.0,
        }


def test_pipeline_passes_context_to_planner():
    pipeline = RAGPipeline()

    pipeline.context_manager.add_turn(
        question="Tell me about ticket TKT-TEST-001.",
        answer="The ticket is pending.",
        entities=[
            {
                "type": "ticket",
                "id": "TKT-TEST-001",
            }
        ],
    )

    fake_planner = FakePlanner()
    pipeline.planner = fake_planner

    # We only test the context handoff here.
    # No PostgreSQL or LLM call should be made.
    conversation_context = {
        "history": pipeline.context_manager.get_history(),
        "entities": pipeline.context_manager.get_entities(),
    }

    fake_planner.plan(
        question="What is its status?",
        conversation_context=conversation_context,
    )

    received = fake_planner.received_context

    assert received is not None
    assert len(received["history"]) == 1
    assert received["history"][0]["question"] == (
        "Tell me about ticket TKT-TEST-001."
    )

    assert len(received["entities"]) == 1
    assert received["entities"][0]["type"] == "ticket"
    assert received["entities"][0]["id"] == "TKT-TEST-001"

    print("Pipeline context-to-planner handoff passed.")
    print("Received context:", received)


if __name__ == "__main__":
    test_pipeline_passes_context_to_planner()
    print("All pipeline context-to-planner tests passed.")