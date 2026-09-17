from typing import Any

from psycopg2 import errors

from context.context_manager import ContextManager
from entity_resolution.entity_normalizer import normalize_entity_candidates
from entity_resolution.entity_resolver import EntityResolver
from entity_resolution.entity_search import extract_entity_search_text
from entity_resolution.entity_selector import select_entity
from llm.answer_generator import AnswerGenerator
from llm.evidence_manager import EvidenceManager
from planning.question_plan_validator import QuestionPlanValidator
from planning.question_planner import QuestionPlanner
from retrieval.retrieval_contract import create_retrieval_contract
from retrieval.retrieval_executor import RetrievalExecutor
from retrieval.sql_generator import SQLGenerator
from tracing.source_tracker import SourceTracker


class RAGPipeline:
    """
    Orchestrate dynamic question planning and read-only retrieval.

    No database schema is hardcoded here.
    PostgreSQL access happens only through the read-only
    retrieval executor.
    """

    def __init__(
        self,
        context_manager: ContextManager | None = None,
    ):
        self.context_manager = (
            context_manager
            if context_manager is not None
            else ContextManager()
        )
        self.entity_resolver = EntityResolver()

        self.planner = QuestionPlanner()
        self.plan_validator = QuestionPlanValidator()
        self.sql_generator = SQLGenerator()
        self.executor = RetrievalExecutor()
        self.source_tracker = SourceTracker()
        self.evidence_manager = EvidenceManager()
        self.answer_generator = AnswerGenerator()

    def ask(
        self,
        question: str,
    ) -> dict[str, Any]:

        if not question or not question.strip():
            raise ValueError(
                "Question cannot be empty."
            )

        # --------------------------------------------------
        # 1. Get previous conversational context
        # --------------------------------------------------

        conversation_context = {
            "history": self.context_manager.get_history(),
            "entities": self.context_manager.get_entities(),
        }

        # --------------------------------------------------
        # 2. Resolve an explicit entity from the question
        # --------------------------------------------------

        search_text = extract_entity_search_text(question)

        resolved_entity = None

        if search_text:
            candidates = self.entity_resolver.resolve(search_text)
            normalized_candidates = normalize_entity_candidates(
                candidates
            )
            resolved_entity = select_entity(
                normalized_candidates
            )

        if resolved_entity:
            conversation_context["entities"] = [
                *conversation_context["entities"],
                resolved_entity,
            ]

        # --------------------------------------------------
        # 3. Dynamically plan the question
        # --------------------------------------------------

        plan = self.planner.plan(
            question=question,
            conversation_context=conversation_context,
        )

        # --------------------------------------------------
        # 4. Validate the LLM-generated plan
        # --------------------------------------------------

        validation = self.plan_validator.validate(
            plan
        )

        if not validation["valid"]:
            raise ValueError(
                "Question plan validation failed: "
                f"{validation['errors']}"
            )

        # --------------------------------------------------
        # 5. Create retrieval contract
        # --------------------------------------------------

        contract = create_retrieval_contract(
            validation
        )

        contract_dict = contract.to_dict()

        # --------------------------------------------------
        # 6. Generate SQL dynamically
        # --------------------------------------------------

        sql = self.sql_generator.generate(
            contract_dict
        )

        # --------------------------------------------------
        # 7. Execute read-only retrieval (with 1 repair attempt on SQL execution errors)
        # --------------------------------------------------

        try:
            retrieval = self.executor.execute(
                sql
            )
        except (
            errors.GroupingError,
            errors.DatatypeMismatch,
            errors.UndefinedColumn,
            errors.UndefinedTable,
            errors.InvalidTextRepresentation,
            errors.UndefinedFunction,
        ) as exc:
            repaired_sql = self.sql_generator.repair(
                query=sql,
                database_error=str(exc),
                contract=contract_dict,
            )

            sql = repaired_sql

            retrieval = self.executor.execute(
                sql
            )

        # --------------------------------------------------
        # 8. Track retrieval sources
        # --------------------------------------------------

        sources = self.source_tracker.build_sources(
            query=sql,
            retrieval=retrieval,
            contract=contract_dict,
        )

        # --------------------------------------------------
        # 9. Prepare bounded evidence for the LLM
        # --------------------------------------------------

        evidence = self.evidence_manager.prepare(
            retrieval=retrieval,
            sources=sources,
        )

        # --------------------------------------------------
        # 10. Generate answer from bounded evidence
        # --------------------------------------------------

        answer = self.answer_generator.generate(
            question=question,
            evidence=evidence,
        )

        # --------------------------------------------------
        # 11. Persist turn into conversation context
        # --------------------------------------------------

        self.context_manager.add_turn(
            question=question,
            answer=answer,
            entities=plan.get("entities", []),
        )

        return {
            "question": question,
            "plan": plan,
            "retrieval_contract": contract_dict,
            "sql": sql,
            "retrieval": retrieval,
            "evidence": evidence,
            "sources": sources,
            "answer": answer,
        }