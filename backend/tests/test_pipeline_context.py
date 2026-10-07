from context.context_manager import ContextManager


def test_pipeline_context_storage():
    context_manager = ContextManager(
        max_turns=5,
        max_items=20,
    )

    context_manager.add_turn(
        question="Which records were created most recently?",
        answer="The latest record was a project activity.",
        entities=[
            {
                "type": "recent_activity",
                "id": "123",
            }
        ],
    )

    history = context_manager.get_history()
    entities = context_manager.get_entities()

    assert len(history) == 1
    assert history[0]["question"] == (
        "Which records were created most recently?"
    )
    assert history[0]["answer"] == (
        "The latest record was a project activity."
    )

    assert len(entities) == 1
    assert entities[0]["type"] == "recent_activity"
    assert entities[0]["id"] == "123"

    print("Context storage passed.")
    print("History:", history)
    print("Entities:", entities)
    print("All pipeline context tests passed.")


if __name__ == "__main__":
    test_pipeline_context_storage()

