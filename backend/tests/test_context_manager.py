from context.context_manager import ContextManager


def test_initialization():
    manager = ContextManager()

    assert manager.get_history() == []
    assert manager.get_entities() == []

    print("Context manager initialization passed.")


def test_add_turn():
    manager = ContextManager()

    entities = [
        {
            "entity_type": "dynamic_table",
            "entity_table": "example_table",
            "entity_column": "name",
            "value": "Example",
            "confidence": 1.0,
        }
    ]

    manager.add_turn(
        question="Tell me about Example.",
        answer="Example information.",
        entities=entities,
    )

    assert len(manager.get_history()) == 1
    assert len(manager.get_entities()) == 1

    print("Context turn storage passed.")


def test_last_turn():
    manager = ContextManager()

    manager.add_turn(
        question="First question",
        answer="First answer",
    )

    manager.add_turn(
        question="Second question",
        answer="Second answer",
    )

    last_turn = manager.get_last_turn()

    assert last_turn is not None
    assert last_turn["question"] == "Second question"

    print("Last-turn retrieval passed.")


def test_last_entities():
    manager = ContextManager()

    entities = [
        {
            "entity_type": "dynamic_table",
            "entity_table": "example_table",
            "entity_column": "name",
            "value": "Example",
            "confidence": 1.0,
        }
    ]

    manager.add_turn(
        question="Tell me about Example.",
        answer="Example information.",
        entities=entities,
    )

    last_entities = manager.get_last_entities()

    assert len(last_entities) == 1
    assert last_entities[0]["value"] == "Example"

    print("Last-entity retrieval passed.")


def test_history_limit():
    manager = ContextManager(max_turns=2)

    manager.add_turn("Question 1", "Answer 1")
    manager.add_turn("Question 2", "Answer 2")
    manager.add_turn("Question 3", "Answer 3")

    history = manager.get_history()

    assert len(history) == 2
    assert history[0]["question"] == "Question 2"
    assert history[1]["question"] == "Question 3"

    print("History limit passed.")


def test_clear():
    manager = ContextManager()

    manager.add_turn(
        "Question",
        "Answer",
    )

    manager.clear()

    assert manager.get_history() == []
    assert manager.get_entities() == []

    print("Context clearing passed.")


if __name__ == "__main__":
    test_initialization()
    test_add_turn()
    test_last_turn()
    test_last_entities()
    test_history_limit()
    test_clear()

    print("All context manager tests passed.")