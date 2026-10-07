from __future__ import annotations

import os
from copy import deepcopy
from typing import Any

from dotenv import load_dotenv


load_dotenv()


class ContextManager:
    """
    Manage bounded short-term conversational context.

    This class stores conversational state only.

    It is NOT:
        - a database cache
        - a source of business truth
        - a replacement for live retrieval
        - a semantic planner

    Historical answers and resolved entities may help interpret a follow-up
    question, but they must never be treated as authoritative current data.
    Current business facts must always come from live retrieval.
    """

    def __init__(
        self,
        max_turns: int | None = None,
        max_items: int | None = None,
        max_question_chars: int | None = None,
        max_answer_chars: int | None = None,
        max_entity_chars: int | None = None,
    ) -> None:
        self.max_turns = self._read_positive_int(
            explicit_value=max_turns,
            env_name="CONTEXT_MAX_TURNS",
            default=5,
        )

        self.max_items = self._read_positive_int(
            explicit_value=max_items,
            env_name="CONTEXT_MAX_ITEMS",
            default=20,
        )

        self.max_question_chars = self._read_positive_int(
            explicit_value=max_question_chars,
            env_name="CONTEXT_MAX_QUESTION_CHARS",
            default=4000,
        )

        self.max_answer_chars = self._read_positive_int(
            explicit_value=max_answer_chars,
            env_name="CONTEXT_MAX_ANSWER_CHARS",
            default=20000,
        )

        self.max_entity_chars = self._read_positive_int(
            explicit_value=max_entity_chars,
            env_name="CONTEXT_MAX_ENTITY_CHARS",
            default=8000,
        )

        self.history: list[dict[str, Any]] = []
        self.entities: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    @staticmethod
    def _read_positive_int(
        explicit_value: int | None,
        env_name: str,
        default: int,
    ) -> int:
        if explicit_value is not None:
            value = explicit_value
        else:
            raw_value = os.getenv(
                env_name,
                str(default),
            )

            try:
                value = int(raw_value)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"{env_name} must be a valid integer."
                ) from exc

        if isinstance(value, bool) or value < 1:
            raise ValueError(
                f"{env_name} must be greater than 0."
            )

        return value

    # ------------------------------------------------------------------
    # Turn management
    # ------------------------------------------------------------------

    def add_turn(
        self,
        question: str,
        answer: str,
        entities: list[dict[str, Any]] | None = None,
    ) -> None:
        """
        Store one conversational turn.

        Only bounded copies are stored. Callers cannot mutate the internal
        context through references returned by this class.
        """

        question = self._normalize_text(
            question,
            "Question",
            self.max_question_chars,
        )

        answer = self._normalize_text(
            answer,
            "Answer",
            self.max_answer_chars,
        )

        normalized_entities = self._normalize_entities(
            entities
        )

        turn = {
            "question": question,
            "answer": answer,
            "entities": normalized_entities,
            "context_role": "conversation_reference",
        }

        self.history.append(
            turn
        )

        if normalized_entities:
            self.entities.extend(
                deepcopy(normalized_entities)
            )

        self._trim()

    def _normalize_text(
        self,
        value: str,
        label: str,
        maximum: int,
    ) -> str:
        if not isinstance(
            value,
            str,
        ):
            raise ValueError(
                f"{label} must be a string."
            )

        value = value.strip()

        if not value:
            raise ValueError(
                f"{label} cannot be empty."
            )

        if len(value) > maximum:
            raise ValueError(
                f"{label} exceeds the configured maximum "
                f"of {maximum} characters."
            )

        return value

    # ------------------------------------------------------------------
    # Entity management
    # ------------------------------------------------------------------

    def _normalize_entities(
        self,
        entities: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        if entities is None:
            return []

        if not isinstance(
            entities,
            list,
        ):
            raise ValueError(
                "entities must be a list."
            )

        normalized: list[
            dict[str, Any]
        ] = []

        for entity in entities:
            if not isinstance(
                entity,
                dict,
            ):
                continue

            entity_copy = deepcopy(
                entity
            )

            entity_copy = self._bound_object(
                entity_copy,
                self.max_entity_chars,
            )

            normalized.append(
                entity_copy
            )

        return normalized

    def _bound_object(
        self,
        value: Any,
        maximum_chars: int,
    ) -> Any:
        """
        Keep conversational context bounded even when an entity resolver
        returns a large nested payload.
        """

        if isinstance(
            value,
            dict,
        ):
            result: dict[str, Any] = {}

            for key, item in value.items():
                normalized_key = str(
                    key
                )

                child = self._bound_object(
                    item,
                    maximum_chars,
                )

                result[
                    normalized_key
                ] = child

            return result

        if isinstance(
            value,
            list,
        ):
            return [
                self._bound_object(
                    item,
                    maximum_chars,
                )
                for item in value
            ]

        if isinstance(
            value,
            str,
        ):
            if len(value) <= maximum_chars:
                return value

            return value[
                :maximum_chars
            ] + "…"

        return value

    # ------------------------------------------------------------------
    # Context trimming
    # ------------------------------------------------------------------

    def _trim(self) -> None:
        self.history = self.history[
            -self.max_turns:
        ]

        self.entities = self.entities[
            -self.max_items:
        ]

    # ------------------------------------------------------------------
    # Read-only accessors
    # ------------------------------------------------------------------

    def get_history(
        self,
    ) -> list[dict[str, Any]]:
        """
        Return isolated conversation history.

        Consumers cannot mutate the internal state.
        """

        return deepcopy(
            self.history
        )

    def get_entities(
        self,
    ) -> list[dict[str, Any]]:
        """
        Return isolated resolved-entity context.
        """

        return deepcopy(
            self.entities
        )

    def get_last_turn(
        self,
    ) -> dict[str, Any] | None:
        if not self.history:
            return None

        return deepcopy(
            self.history[-1]
        )

    def get_last_entities(
        self,
    ) -> list[dict[str, Any]]:
        last_turn = self.get_last_turn()

        if not last_turn:
            return []

        entities = last_turn.get(
            "entities",
            [],
        )

        if not isinstance(
            entities,
            list,
        ):
            return []

        return deepcopy(
            entities
        )

    # ------------------------------------------------------------------
    # Planner-facing context
    # ------------------------------------------------------------------

    def get_planning_context(
        self,
    ) -> dict[str, Any]:
        """
        Return conversation context specifically for QuestionPlanner.

        This explicitly labels historical information as conversational
        context rather than authoritative business evidence.

        The planner may use it to resolve references such as:
            "that company"
            "those projects"
            "the same user"

        It must still perform fresh retrieval for current business facts.
        """

        return {
            "history": self.get_history(),
            "entities": self.get_entities(),
            "authority": {
                "conversation_history": "reference_only",
                "resolved_entities": "reference_only",
                "current_business_data": "live_retrieval_required",
            },
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def clear(self) -> None:
        self.history.clear()
        self.entities.clear()