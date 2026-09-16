from entity_resolution.entity_search import (
    extract_entity_search_text,
)


def test_identifier_extraction():
    result = extract_entity_search_text(
        "Tell me about ticket TKT-MU2JXPTA-WXLJ."
    )

    assert result == "TKT-MU2JXPTA-WXLJ"

    print("Identifier extraction passed.")


def test_quoted_value_extraction():
    result = extract_entity_search_text(
        "Tell me about 'Client Admin'."
    )

    assert result == "Client Admin"

    print("Quoted value extraction passed.")


def test_empty_question():
    result = extract_entity_search_text("")

    assert result is None

    print("Empty question handling passed.")


def test_no_entity_reference():
    result = extract_entity_search_text(
        "Which records were created most recently?"
    )

    assert result is None

    print("No entity reference handling passed.")


if __name__ == "__main__":
    test_identifier_extraction()
    test_quoted_value_extraction()
    test_empty_question()
    test_no_entity_reference()

    print("All entity search tests passed.")