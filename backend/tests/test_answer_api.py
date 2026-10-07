from llm.answer_generator import AnswerGenerator


def test_answer_api():

    generator = AnswerGenerator()

    question = "Which record was created most recently?"

    retrieval = {
        "rows": [
            {
                "record_type": "example_table",
                "id": "101",
                "created_at": "2026-09-15 14:30:00",
            },
            {
                "record_type": "another_table",
                "id": "202",
                "created_at": "2026-09-14 10:20:00",
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
        }
    ]

    answer = generator.generate(
        question=question,
        retrieval=retrieval,
        sources=sources,
    )

    assert answer
    assert isinstance(answer, str)

    print("\nGenerated answer:")
    print(answer)

    print("\nOne OpenAI answer-generation call completed.")
    print("Answer generator API test passed.")


if __name__ == "__main__":
    test_answer_api()