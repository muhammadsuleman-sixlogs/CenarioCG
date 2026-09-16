import json

from planning.question_planner import QuestionPlanner


def test_conversation_aware_planning():
    planner = QuestionPlanner()

    conversation_context = {
        "history": [
            {
                "question": "Tell me about ticket TKT-MU2JXPTA-WXLJ.",
                "answer": "The ticket is scheduled and concerns Testing about mazzotta.",
                "entities": [
                    {
                        "type": "ticket",
                        "id": "TKT-MU2JXPTA-WXLJ",
                    }
                ],
            }
        ],
        "entities": [
            {
                "type": "ticket",
                "id": "TKT-MU2JXPTA-WXLJ",
            }
        ],
    }

    result = planner.plan(
        question="What is its status?",
        conversation_context=conversation_context,
    )

    print("Planner result:")
    print(json.dumps(result, indent=2, default=str))

    assert isinstance(result, dict)
    assert result.get("needs_conversation_context") is True

    print("Conversation-aware planner test passed.")


if __name__ == "__main__":
    test_conversation_aware_planning()
    print("All conversation planner tests passed.")