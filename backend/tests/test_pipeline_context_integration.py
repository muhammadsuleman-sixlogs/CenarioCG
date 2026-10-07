from pipeline.rag_pipeline import RAGPipeline


def test_pipeline_stores_context():
    pipeline = RAGPipeline()

    pipeline.context_manager.add_turn(
        question="Which records were created most recently?",
        answer="The latest records were tickets.",
        entities=[
            {
                "type": "ticket",
                "id": "TKT-TEST-001",
            }
        ],
    )

    history = pipeline.context_manager.get_history()
    entities = pipeline.context_manager.get_entities()

    assert len(history) == 1
    assert history[0]["question"] == "Which records were created most recently?"
    assert history[0]["answer"] == "The latest records were tickets."

    assert len(entities) == 1
    assert entities[0]["type"] == "ticket"
    assert entities[0]["id"] == "TKT-TEST-001"

    print("Pipeline context integration passed.")
    print("History:", history)
    print("Entities:", entities)


if __name__ == "__main__":
    test_pipeline_stores_context()
    print("All pipeline context integration tests passed.")