from entity_resolution.entity_normalizer import (
    normalize_entity_candidates,
)
from entity_resolution.entity_selector import (
    select_entity,
)


def test_entity_resolution_chain():
    resolver_candidates = [
        {
            "entity_type": "tickets",
            "entity_table": "tickets",
            "entity_column": "reference_id",
            "value": "TKT-MU2JXPTA-WXLJ",
            "confidence": 1.0,
            "match_type": "exact",
            "evidence": "tickets.reference_id",
        }
    ]

    normalized = normalize_entity_candidates(
        resolver_candidates
    )

    selected = select_entity(normalized)

    assert selected is not None
    assert selected["type"] == "tickets"
    assert selected["id"] == "TKT-MU2JXPTA-WXLJ"
    assert selected["confidence"] == 1.0

    print("Resolver → normalizer → selector chain passed.")


if __name__ == "__main__":
    test_entity_resolution_chain()

    print("Entity resolution chain test passed.")