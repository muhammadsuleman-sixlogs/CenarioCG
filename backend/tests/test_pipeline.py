from pipeline.rag_pipeline import RAGPipeline


def test_pipeline():

    pipeline = RAGPipeline()

    question = "Which records were created most recently?"

    result = pipeline.ask(question)

    assert result["question"] == question

    assert result["plan"]
    assert result["retrieval_contract"]

    assert result["sql"]

    assert result["retrieval"]

    assert "rows" in result["retrieval"]
    assert "row_count" in result["retrieval"]
    assert "columns" in result["retrieval"]

    assert result["evidence"]
    assert "rows" in result["evidence"]
    assert "row_count" in result["evidence"]
    assert "total_retrieved" in result["evidence"]
    assert "truncated" in result["evidence"]
    assert "sources" in result["evidence"]

    assert result["answer"]

    print("Pipeline question:", result["question"])

    print("\nGenerated SQL:")
    print(result["sql"])

    print(
        "\nRows returned:",
        result["retrieval"]["row_count"],
    )

    print(
        "Columns:",
        result["retrieval"]["columns"],
    )

    print(
        "\nEvidence rows:",
        result["evidence"]["row_count"],
    )
    print(
        "Total retrieved:",
        result["evidence"]["total_retrieved"],
    )
    print(
        "Evidence truncated:",
        result["evidence"]["truncated"],
    )

    print("\nFinal Answer:")
    print(result["answer"])

    print("\nEnd-to-end retrieval pipeline passed.")


if __name__ == "__main__":

    test_pipeline()

    print(
        "All pipeline tests passed."
    )