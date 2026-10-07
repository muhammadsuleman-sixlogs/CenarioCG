from pipeline.rag_pipeline import RAGPipeline


def test_entity_resolution_handoff():
    pipeline = RAGPipeline()

    captured = {}

    original_plan = pipeline.planner.plan

    def capture_plan(question, conversation_context=None):
        captured["context"] = conversation_context
        return original_plan(
            question=question,
            conversation_context=conversation_context,
        )

    pipeline.planner.plan = capture_plan

    question = "Tell me about ticket TKT-MU2JXPTA-WXLJ."

    # Run only far enough to capture planner context.
    # Replace downstream components temporarily so nothing is executed.
    original_validator = pipeline.plan_validator.validate

    def stop_after_planner(plan):
        captured["plan"] = plan
        raise RuntimeError("STOP_AFTER_PLANNER")

    pipeline.plan_validator.validate = stop_after_planner

    try:
        pipeline.ask(question)
    except RuntimeError as exc:
        assert str(exc) == "STOP_AFTER_PLANNER"

    context = captured["context"]

    assert "entities" in context
    assert context["entities"]

    entity = context["entities"][-1]

    assert entity["id"] == "TKT-MU2JXPTA-WXLJ"
    assert entity["confidence"] == 1.0
    assert entity["evidence"] == "tickets.reference_id"

    print("Entity resolution → planner handoff passed.")
    print("Resolved entity:", entity)


if __name__ == "__main__":
    test_entity_resolution_handoff()
    print("All pipeline entity resolution tests passed.")