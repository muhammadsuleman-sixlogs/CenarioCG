from pipeline.rag_pipeline import RAGPipeline


def test_conversation_follow_up():
    pipeline = RAGPipeline()

    # Turn 1
    first_question = (
        "Tell me about ticket TKT-MU2JXPTA-WXLJ."
    )

    first_result = pipeline.ask(first_question)

    print("\n--- TURN 1 ---")
    print("Question:", first_question)
    print("Plan:", first_result["plan"])
    print("Answer:", first_result["answer"])

    # Confirm the entity was stored.
    entities = pipeline.context_manager.get_entities()

    assert entities, "No entity was stored after the first question."

    print("Stored entities:", entities)

    # Turn 2
    second_question = "What is its subject?"

    second_result = pipeline.ask(second_question)

    print("\n--- TURN 2 ---")
    print("Question:", second_question)
    print("Plan:", second_result["plan"])
    print("SQL:", second_result["sql"])
    print("Answer:", second_result["answer"])

    # The planner should have used conversation context.
    assert second_result["plan"]["needs_conversation_context"] is True

    # The previous ticket should appear in the second plan.
    second_entities = second_result["plan"].get("entities", [])

    assert any(
        entity.get("id") == "TKT-MU2JXPTA-WXLJ"
        for entity in second_entities
        if isinstance(entity, dict)
    )

    print("\nConversation follow-up resolved successfully.")
    print("All conversation E2E tests passed.")


if __name__ == "__main__":
    test_conversation_follow_up()