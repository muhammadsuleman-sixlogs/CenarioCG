import os
from typing import Any

from dotenv import load_dotenv


load_dotenv()


class ContextManager:
    """
    Manage short-term conversational context.

    Configuration is loaded from environment variables.
    PostgreSQL is not accessed or modified.
    """

    def __init__(
        self,
        max_turns: int | None = None,
        max_items: int | None = None,
    ):
        self.max_turns = (
            max_turns
            if max_turns is not None
            else int(
                os.getenv(
                    "CONTEXT_MAX_TURNS",
                    "5",
                )
            )
        )

        self.max_items = (
            max_items
            if max_items is not None
            else int(
                os.getenv(
                    "CONTEXT_MAX_ITEMS",
                    "20",
                )
            )
        )

        if self.max_turns < 1:
            raise ValueError(
                "CONTEXT_MAX_TURNS must be greater than 0."
            )

        if self.max_items < 1:
            raise ValueError(
                "CONTEXT_MAX_ITEMS must be greater than 0."
            )

        self.history: list[dict[str, Any]] = []
        self.entities: list[dict[str, Any]] = []

    def add_turn(
        self,
        question: str,
        answer: str,
        entities: list[dict[str, Any]] | None = None,
    ) -> None:

        if not question or not question.strip():
            raise ValueError(
                "Question cannot be empty."
            )

        turn = {
            "question": question.strip(),
            "answer": answer,
            "entities": entities or [],
        }

        self.history.append(turn)

        if entities:
            self.entities.extend(entities)

        self.history = self.history[
            -self.max_turns:
        ]

        self.entities = self.entities[
            -self.max_items:
        ]

    def get_history(self) -> list[dict[str, Any]]:
        return list(self.history)

    def get_entities(self) -> list[dict[str, Any]]:
        return list(self.entities)

    def get_last_turn(
        self,
    ) -> dict[str, Any] | None:

        if not self.history:
            return None

        return self.history[-1]

    def get_last_entities(
        self,
    ) -> list[dict[str, Any]]:

        last_turn = self.get_last_turn()

        if not last_turn:
            return []

        return list(
            last_turn.get("entities", [])
        )

    def clear(self) -> None:
        self.history.clear()
        self.entities.clear()