from copy import deepcopy
from typing import Any
from psycopg2 import errors

from context.context_manager import ContextManager
from context.context_store import load_all_contexts, load_context
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
from security.output_security_policy import sanitize_api_response, sanitize_evidence
from security_logs.retriever import SecurityLogRetriever
from tracing.source_tracker import SourceTracker


class RAGPipeline:
    SQL_REPAIR_ERRORS = (
        errors.GroupingError,
        errors.DatatypeMismatch,
        errors.UndefinedColumn,
        errors.UndefinedTable,
        errors.InvalidTextRepresentation,
        errors.UndefinedFunction,
    )
    ALLOWED_DATA_SOURCES = {"postgresql", "security_logs"}
    ALLOWED_SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
    }
    DEFAULT_SECURITY_RESOURCE = "security_logs"

    def __init__(self, context_manager: ContextManager | None = None):
        self.context_manager = context_manager if context_manager is not None else ContextManager()
        self.entity_resolver = EntityResolver()
        self.planner = QuestionPlanner()
        self.plan_validator = QuestionPlanValidator()
        self.sql_generators: dict[str, SQLGenerator] = {}
        self.executor = RetrievalExecutor()
        self.source_tracker = SourceTracker()
        self.security_log_retriever = SecurityLogRetriever()
        self.evidence_manager = EvidenceManager()
        self.answer_generator = AnswerGenerator()

    def _validate_question(self, question: str) -> str:
        if not isinstance(question, str):
            raise ValueError("Question must be a string.")
        question = question.strip()
        if not question:
            raise ValueError("Question cannot be empty.")
        if len(question) > 4000:
            raise ValueError(
                "Question is too long. Please keep it under 4000 characters."
            )
        return question

    def _get_conversation_context(self) -> dict[str, Any]:
        return {
            "history": self.context_manager.get_history(),
            "entities": self.context_manager.get_entities(),
        }

    def _resolve_entity(
        self,
        question: str,
        conversation_context: dict[str, Any],
    ) -> None:
        search_text = extract_entity_search_text(question)
        if not search_text:
            return
        candidates = self.entity_resolver.resolve(search_text)
        normalized_candidates = normalize_entity_candidates(candidates)
        resolved_entity = select_entity(normalized_candidates)
        if resolved_entity:
            conversation_context["entities"] = [
                *conversation_context["entities"],
                resolved_entity,
            ]

    def _get_data_sources(self, plan: dict[str, Any]) -> list[str]:
        data_sources = plan.get("data_sources", ["postgresql"])
        if not isinstance(data_sources, list):
            raise ValueError("Question plan data_sources must be a list.")
        if not data_sources:
            raise ValueError("Question plan did not select a data source.")
        invalid_sources = [
            source for source in data_sources
            if source not in self.ALLOWED_DATA_SOURCES
        ]
        if invalid_sources:
            raise ValueError(
                f"Question plan selected unsupported data source(s): {invalid_sources}"
            )
        return list(dict.fromkeys(data_sources))

    def _get_security_resource(
        self,
        plan: dict[str, Any],
        data_sources: list[str],
    ) -> str | None:
        if "security_logs" not in data_sources:
            return None
        resource = plan.get("security_resource", self.DEFAULT_SECURITY_RESOURCE)
        if resource is None:
            resource = self.DEFAULT_SECURITY_RESOURCE
        if not isinstance(resource, str):
            raise ValueError("Question plan security_resource must be a string.")
        resource = resource.strip()
        if not resource:
            resource = self.DEFAULT_SECURITY_RESOURCE
        if resource not in self.ALLOWED_SECURITY_RESOURCES:
            raise ValueError(
                f"Question plan selected unsupported security resource: {resource!r}"
            )
        return resource

    def _get_postgresql_sources(self, plan: dict[str, Any]) -> list[str]:
        sources = plan.get("postgresql_sources", [])
        if not isinstance(sources, list):
            raise ValueError("Question plan postgresql_sources must be a list.")
        sources = list(dict.fromkeys(sources))
        if "postgresql" not in plan.get("data_sources", []):
            return []
        if not sources:
            raise ValueError(
                "PostgreSQL was selected but no PostgreSQL source was specified."
            )
        available_sources = set(load_all_contexts().keys())
        invalid_sources = [
            source for source in sources
            if source not in available_sources
        ]
        if invalid_sources:
            raise ValueError(
                f"Question plan selected unavailable PostgreSQL source(s): {invalid_sources}"
            )
        return sources

    def _get_sql_generator(self, source_id: str) -> SQLGenerator:
        if source_id not in self.sql_generators:
            self.sql_generators[source_id] = SQLGenerator(source_id=source_id)
        return self.sql_generators[source_id]

    def _build_source_validation(
        self,
        plan: dict[str, Any],
        source_id: str,
    ) -> dict[str, Any] | None:
        if not isinstance(source_id, str) or not source_id.strip():
            return None

        source_id = source_id.strip().lower()
        contexts = load_all_contexts()
        context = contexts.get(source_id)
        if not isinstance(context, dict):
            return None

        tables = context.get("tables", {})
        if not isinstance(tables, dict):
            return None

        source_tables = {str(table_name) for table_name in tables.keys()}

        required_tables = plan.get("required_tables", [])
        if not isinstance(required_tables, list):
            required_tables = []

        normalized_required_tables = [
            str(table_name).strip()
            for table_name in required_tables
            if isinstance(table_name, str) and table_name.strip()
        ]
        missing_tables = [
            table_name
            for table_name in normalized_required_tables
            if table_name not in source_tables
        ]
        if missing_tables:
            return None

        required_columns = plan.get("required_columns", [])
        if not isinstance(required_columns, list):
            required_columns = []

        source_columns: dict[str, set[str]] = {}
        for table_name, table_info in tables.items():
            if not isinstance(table_info, dict):
                continue
            columns = table_info.get("columns", [])
            if not isinstance(columns, list):
                continue

            usable_columns = set()
            for column in columns:
                if not isinstance(column, dict):
                    continue
                column_name = column.get("name")
                if not column_name:
                    continue
                usable_columns.add(str(column_name))
            source_columns[str(table_name)] = usable_columns

        missing_columns = []
        for field in required_columns:
            if not isinstance(field, dict):
                continue
            table_name = field.get("table")
            column_name = field.get("column")
            if not table_name or not column_name:
                continue

            table_name = str(table_name)
            column_name = str(column_name)
            available_columns = source_columns.get(table_name, set())

            if column_name not in available_columns:
                missing_columns.append({
                    "table": table_name,
                    "column": column_name,
                })

        if missing_columns:
            return None

        relationships = plan.get("relationships", [])
        if not isinstance(relationships, list):
            relationships = []

        context_relationships = context.get("relationships", [])
        if not isinstance(context_relationships, list):
            context_relationships = []

        normalized_context_relationships = []
        for relationship in context_relationships:
            if not isinstance(relationship, dict):
                continue

            source_table = relationship.get("source_table")
            target_table = relationship.get("target_table")
            if not source_table or not target_table:
                continue

            normalized_context_relationships.append({
                "source_table": str(source_table),
                "target_table": str(target_table),
            })

        for relationship in relationships:
            if not isinstance(relationship, dict):
                continue

            source_table = relationship.get("source_table")
            target_table = relationship.get("target_table")
            if not source_table or not target_table:
                continue

            source_table = str(source_table)
            target_table = str(target_table)

            relationship_exists = any(
                item["source_table"] == source_table
                and item["target_table"] == target_table
                for item in normalized_context_relationships
            )
            if not relationship_exists:
                return None

        source_plan = deepcopy(plan)
        source_plan["data_sources"] = ["postgresql"]
        source_plan["postgresql_sources"] = [source_id]

        return {
            "valid": True,
            "source_id": source_id,
            "plan": source_plan,
            "missing_tables": [],
            "missing_columns": [],
            "missing_relationships": [],
        }

    def _retrieve_postgresql(
        self,
        contract_dict: dict[str, Any],
        source_id: str,
    ) -> dict[str, Any]:
        try:
            if not source_id:
                raise ValueError("PostgreSQL source_id cannot be empty.")

            sql_generator = self._get_sql_generator(source_id)
            sql = sql_generator.generate(
                contract=contract_dict,
                source_id=source_id,
            )
            repaired = False

            try:
                retrieval = self.executor.execute(
                    query=sql,
                    source_id=source_id,
                )
            except self.SQL_REPAIR_ERRORS as exc:
                repaired_sql = sql_generator.repair(
                    query=sql,
                    database_error=str(exc),
                    contract=contract_dict,
                    source_id=source_id,
                )
                sql = repaired_sql
                repaired = True
                retrieval = self.executor.execute(
                    query=sql,
                    source_id=source_id,
                )

            source = self.source_tracker.build_sources(
                query=sql,
                retrieval=retrieval,
                contract=contract_dict,
                source_id=source_id,
            )
            retrieval_status = retrieval.get(
                "retrieval_status",
                "success_with_data"
                if retrieval.get("row_count", 0) > 0
                else "success_empty",
            )

            return {
                "source_type": "postgresql",
                "source_id": source_id,
                "retrieval_status": retrieval_status,
                "retrieval": retrieval,
                "sql": sql,
                "repaired": repaired,
                "sources": source,
            }

        except Exception as exc:
            print(
                "POSTGRESQL RETRIEVAL FAILED:",
                source_id,
                type(exc).__name__,
                str(exc),
            )
            return {
                "source_type": "postgresql",
                "source_id": source_id,
                "retrieval_status": "retrieval_failed",
                "retrieval": {
                    "rows": [],
                    "row_count": 0,
                    "columns": [],
                },
                "sql": None,
                "repaired": False,
                "sources": [],
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                },
            }

    def _retrieve_security_logs(
        self,
        plan: dict[str, Any],
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        resource = plan.get(
            "security_resource",
            self.DEFAULT_SECURITY_RESOURCE,
        )
        if resource is None:
            resource = self.DEFAULT_SECURITY_RESOURCE
        if not isinstance(resource, str):
            raise ValueError("security_resource must be a string.")

        resource = resource.strip()
        if not resource:
            resource = self.DEFAULT_SECURITY_RESOURCE

        if resource not in self.ALLOWED_SECURITY_RESOURCES:
            raise ValueError(f"Unsupported security resource: {resource!r}")

        limit = plan.get("limit")
        if not isinstance(limit, int) or limit <= 0:
            limit = 100

        try:
            if resource == "security_logs":
                security_retrieval = self.security_log_retriever.retrieve(limit=limit)

            elif resource == "cli_audit_logs":
                retriever_method = getattr(
                    self.security_log_retriever,
                    "retrieve_cli_audit_logs",
                    None,
                )
                if not callable(retriever_method):
                    raise RuntimeError(
                        "SecurityLogRetriever does not expose retrieve_cli_audit_logs()."
                    )
                security_retrieval = retriever_method(limit=limit)

            elif resource == "security_logs_summary":
                retriever_method = getattr(
                    self.security_log_retriever,
                    "retrieve_security_logs_summary",
                    None,
                )
                if not callable(retriever_method):
                    raise RuntimeError(
                        "SecurityLogRetriever does not expose "
                        "retrieve_security_logs_summary()."
                    )
                security_retrieval = retriever_method()

            elif resource == "workspace_security_logs":
                if not workspace_id:
                    raise ValueError(
                        "workspace_id is required for workspace_security_logs."
                    )
                security_retrieval = (
                    self.security_log_retriever.retrieve_workspace_security_logs(
                        workspace_id=workspace_id,
                        limit=limit,
                    )
                )

            elif resource == "workspace_siem_status":
                if not workspace_id:
                    raise ValueError(
                        "workspace_id is required for workspace_siem_status."
                    )
                retriever_method = getattr(
                    self.security_log_retriever,
                    "retrieve_workspace_siem_status",
                    None,
                )
                if not callable(retriever_method):
                    raise RuntimeError(
                        "SecurityLogRetriever does not expose "
                        "retrieve_workspace_siem_status()."
                    )
                security_retrieval = retriever_method(
                    workspace_id=workspace_id,
                )

            elif resource == "security_overview":
                retriever_method = getattr(
                    self.security_log_retriever,
                    "retrieve_security_overview",
                    None,
                )
                if not callable(retriever_method):
                    raise RuntimeError(
                        "SecurityLogRetriever does not expose "
                        "retrieve_security_overview()."
                    )
                security_retrieval = retriever_method()

            else:
                raise ValueError(
                    f"Unsupported security resource: {resource!r}"
                )

            if not isinstance(security_retrieval, dict):
                raise ValueError(
                    "SecurityLogRetriever must return a dictionary."
                )

            events = security_retrieval.get("events", [])
            if not isinstance(events, list):
                events = []

            data = security_retrieval.get("data")
            meaningful_keys = {
                key
                for key, value in security_retrieval.items()
                if key not in {
                    "source",
                    "source_id",
                    "resource",
                    "retrieved_at",
                    "workspace_id",
                }
                and value not in (None, {}, [], "")
            }

            meaningful_data = bool(
                events
                or data not in (None, {}, [], "")
                or meaningful_keys
            )
            retrieval_status = (
                "success_with_data"
                if meaningful_data
                else "success_empty"
            )

            source = {
                "source_type": "security_logs_api",
                "source_id": security_retrieval.get(
                    "source_id",
                    "security_logs",
                ),
                "source": security_retrieval.get(
                    "source",
                    "security_logs_api",
                ),
                "resource": security_retrieval.get(
                    "resource",
                    resource,
                ),
                "entities": [],
                "tables": [],
                "columns": [],
            }

            if "workspace_id" in security_retrieval:
                source["workspace_id"] = security_retrieval["workspace_id"]
            if "retrieved_at" in security_retrieval:
                source["retrieved_at"] = security_retrieval["retrieved_at"]
            if "events" in security_retrieval:
                source["event_count"] = len(events)

            return {
                "source_type": "security_logs_api",
                "source_id": "security_logs",
                "resource": resource,
                "retrieval_status": retrieval_status,
                "retrieval": security_retrieval,
                "sources": [source],
            }

        except Exception as exc:
            print(
                "SECURITY LOG RETRIEVAL FAILED:",
                resource,
                type(exc).__name__,
                str(exc),
            )
            return {
                "source_type": "security_logs_api",
                "source_id": "security_logs",
                "resource": resource,
                "retrieval_status": "retrieval_failed",
                "retrieval": {},
                "sources": [],
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                },
            }

    def _prepare_evidence(
        self,
        postgres_results: list[dict[str, Any]],
        security_result: dict[str, Any] | None,
    ) -> dict[str, Any]:
        evidence: dict[str, Any] = {"sources": []}

        if postgres_results:
            combined_rows: list[dict[str, Any]] = []
            combined_columns: list[str] = []
            combined_provenance: list[dict[str, Any]] = []

            for postgres_result in postgres_results:
                retrieval = postgres_result.get("retrieval", {})
                rows = retrieval.get("rows", [])
                if isinstance(rows, list):
                    combined_rows.extend(rows)

                columns = retrieval.get("columns", [])
                if isinstance(columns, list):
                    for column in columns:
                        if column not in combined_columns:
                            combined_columns.append(column)

                provenance = retrieval.get("provenance")
                if isinstance(provenance, dict):
                    combined_provenance.append(provenance)

                evidence["sources"].extend(
                    postgres_result.get("sources", [])
                )

            combined_retrieval = {
                "rows": combined_rows,
                "row_count": len(combined_rows),
                "columns": combined_columns,
                "provenance": {
                    "source_type": "postgresql",
                    "sources": combined_provenance,
                },
            }

            combined_sources = []
            for postgres_result in postgres_results:
                combined_sources.extend(
                    postgres_result.get("sources", [])
                )

            postgres_evidence = self.evidence_manager.prepare(
                retrieval=combined_retrieval,
                sources=combined_sources,
            )
            evidence["postgresql"] = postgres_evidence

        if security_result is not None:
            security_retrieval = security_result.get("retrieval", {})
            security_sources = security_result.get("sources", [])

            evidence["security_logs"] = {
                "source_type": "security_logs_api",
                "resource": security_result.get("resource"),
                "retrieval": security_retrieval,
            }
            evidence["sources"].extend(security_sources)

        return evidence

    def _has_retrieved_data(
        self,
        postgres_results: list[dict[str, Any]],
        security_result: dict[str, Any] | None,
    ) -> bool:
        for postgres_result in postgres_results:
            retrieval = postgres_result.get("retrieval", {})
            rows = retrieval.get("rows", [])
            if rows:
                return True

        if security_result is not None:
            retrieval = security_result.get("retrieval", {})
            events = retrieval.get("events")
            if isinstance(events, list) and events:
                return True

            data = retrieval.get("data")
            if data not in (None, {}, [], ""):
                return True

            meaningful_keys = {
                key
                for key, value in retrieval.items()
                if key not in {
                    "source",
                    "source_id",
                    "resource",
                    "retrieved_at",
                    "workspace_id",
                }
                and value not in (None, {}, [], "")
            }
            if meaningful_keys:
                return True

        return False

    def _validate_workspace_id(
        self,
        workspace_id: str | None,
    ) -> str | None:
        if workspace_id is None:
            return None
        if not isinstance(workspace_id, str):
            raise ValueError("workspace_id must be a string or null.")

        workspace_id = workspace_id.strip()
        if not workspace_id:
            return None
        if len(workspace_id) > 256:
            raise ValueError("workspace_id is too long.")

        return workspace_id

    def _build_source_status(
        self,
        postgres_results: list[dict[str, Any]],
        security_result: dict[str, Any] | None,
    ) -> dict[str, dict[str, Any]]:
        source_status: dict[str, dict[str, Any]] = {}

        for postgres_result in postgres_results:
            source_id = postgres_result.get("source_id")
            if not source_id:
                continue

            retrieval = postgres_result.get("retrieval", {})
            rows = retrieval.get("rows", [])

            source_status[source_id] = {
                "source_type": "postgresql",
                "source_id": source_id,
                "context_available": True,
                "retrieval_status": postgres_result.get(
                    "retrieval_status",
                    "retrieval_failed",
                ),
                "data_available": bool(rows),
                "error": postgres_result.get("error"),
            }

        if security_result is not None:
            retrieval = security_result.get("retrieval", {})
            events = retrieval.get("events")
            data_available = False

            if isinstance(events, list) and events:
                data_available = True

            data = retrieval.get("data")
            if data not in (None, {}, [], ""):
                data_available = True

            meaningful_keys = {
                key
                for key, value in retrieval.items()
                if key not in {
                    "source",
                    "source_id",
                    "retrieved_at",
                    "workspace_id",
                }
                and value not in (None, {}, [], "")
            }

            if meaningful_keys:
                data_available = True

            source_status["security_logs"] = {
                "source_type": "security_logs_api",
                "source_id": "security_logs",
                "context_available": True,
                "retrieval_status": security_result.get(
                    "retrieval_status",
                    "retrieval_failed",
                ),
                "data_available": data_available,
                "error": security_result.get("error"),
            }

        return source_status

    def ask(
        self,
        question: str,
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        clean_question = self._validate_question(question)
        workspace_id = self._validate_workspace_id(workspace_id)

        conversation_context = self._get_conversation_context()
        self._resolve_entity(clean_question, conversation_context)

        raw_plan = self.planner.plan(
            question=clean_question,
            conversation_context=conversation_context,
        )

        validation = self.plan_validator.validate(raw_plan)
        print("RAW QUESTION PLAN:", raw_plan)
        print("QUESTION PLAN VALIDATION:", validation)

        plan_repaired = False

        if not validation.get("valid", False):
            validation_errors = validation.get("errors", [])
            print(
                "QUESTION PLAN INVALID - attempting one "
                "schema-based repair."
            )

            repaired_plan = self.planner.repair_plan(
                question=clean_question,
                invalid_plan=raw_plan,
                validation_errors=validation_errors,
                conversation_context=conversation_context,
            )

            repaired_validation = self.plan_validator.validate(
                repaired_plan
            )
            print("REPAIRED QUESTION PLAN:", repaired_plan)
            print(
                "REPAIRED PLAN VALIDATION:",
                repaired_validation,
            )

            if not repaired_validation.get("valid", False):
                print("QUESTION PLAN REPAIR FAILED.")
                return sanitize_api_response({
                    "question": clean_question,
                    "plan": raw_plan,
                    "plan_repaired": False,
                    "data_sources": [],
                    "postgresql_source_ids": [],
                    "retrieval_status": "planning_failed",
                    "source_status": {},
                    "evidence": {},
                    "sources": [],
                    "answer": (
                        "I could not create a valid retrieval "
                        "plan for this question."
                    ),
                    "error": {
                        "type": "planning_failed",
                        "details": repaired_validation.get(
                            "errors",
                            [],
                        ),
                    },
                })

            validation = repaired_validation
            plan_repaired = True

        validated_plan = validation["plan"]

        data_sources = self._get_data_sources(validated_plan)

        security_resource = self._get_security_resource(
            validated_plan,
            data_sources,
        )
        validated_plan["security_resource"] = security_resource

        postgresql_sources = self._get_postgresql_sources(
            validated_plan
        )

        print("SELECTED POSTGRESQL SOURCES:", postgresql_sources)
        print("SELECTED SECURITY RESOURCE:", security_resource)

        postgres_results: list[dict[str, Any]] = []
        retrieval_contracts: dict[str, dict[str, Any]] = {}

        if postgresql_sources:
            for source_id in postgresql_sources:
                try:
                    source_validation = self._build_source_validation(
                        plan=validated_plan,
                        source_id=source_id,
                    )

                    if source_validation is None:
                        postgres_results.append({
                            "source_type": "postgresql",
                            "source_id": source_id,
                            "retrieval_status": "retrieval_failed",
                            "retrieval": {
                                "rows": [],
                                "row_count": 0,
                                "columns": [],
                            },
                            "sql": None,
                            "repaired": False,
                            "sources": [],
                            "error": {
                                "type": "source_context_unavailable",
                                "message": (
                                    "The selected PostgreSQL source "
                                    "did not contain the required "
                                    "retrieval context."
                                ),
                            },
                        })
                        continue

                    source_plan = source_validation["plan"]
                    contract = create_retrieval_contract(source_plan)
                    source_contract_dict = contract.to_dict()

                    retrieval_contracts[source_id] = source_contract_dict

                    postgres_result = self._retrieve_postgresql(
                        contract_dict=source_contract_dict,
                        source_id=source_id,
                    )
                    postgres_results.append(postgres_result)

                except Exception as exc:
                    print(
                        "POSTGRESQL SOURCE PIPELINE FAILED:",
                        source_id,
                        type(exc).__name__,
                        str(exc),
                    )
                    postgres_results.append({
                        "source_type": "postgresql",
                        "source_id": source_id,
                        "retrieval_status": "retrieval_failed",
                        "retrieval": {
                            "rows": [],
                            "row_count": 0,
                            "columns": [],
                        },
                        "sql": None,
                        "repaired": False,
                        "sources": [],
                        "error": {
                            "type": type(exc).__name__,
                            "message": str(exc),
                        },
                    })

        security_result = None
        if "security_logs" in data_sources:
            security_result = self._retrieve_security_logs(
                plan=validated_plan,
                workspace_id=workspace_id,
            )

        source_status = self._build_source_status(
            postgres_results=postgres_results,
            security_result=security_result,
        )

        retrieval_states = [
            item.get("retrieval_status")
            for item in source_status.values()
        ]
        successful_sources = [
            state
            for state in retrieval_states
            if state in {"success_with_data", "success_empty"}
        ]
        failed_sources = [
            state
            for state in retrieval_states
            if state == "retrieval_failed"
        ]

        has_data = self._has_retrieved_data(
            postgres_results=postgres_results,
            security_result=security_result,
        )

        if has_data:
            if failed_sources:
                overall_retrieval_status = "partial_source_failure"
            else:
                overall_retrieval_status = "success_with_data"
        elif successful_sources:
            if failed_sources:
                overall_retrieval_status = "partial_source_failure"
            else:
                overall_retrieval_status = "success_empty"
        elif failed_sources:
            overall_retrieval_status = "source_unavailable"
        else:
            overall_retrieval_status = "success_empty"

        if overall_retrieval_status == "source_unavailable":
            result = {
                "question": clean_question,
                "plan": validated_plan,
                "plan_repaired": plan_repaired,
                "data_sources": data_sources,
                "security_resource": security_resource,
                "postgresql_source_ids": postgresql_sources,
                "retrieval_contract": retrieval_contracts,
                "evidence": {},
                "answer": (
                    "I could not retrieve live data from the "
                    "selected data source(s), so I cannot "
                    "provide an authoritative answer."
                ),
                "sources": [],
                "source_status": source_status,
                "retrieval_status": overall_retrieval_status,
            }
            return sanitize_api_response(result)

        evidence = self._prepare_evidence(
            postgres_results=postgres_results,
            security_result=security_result,
        )
        evidence = sanitize_evidence(evidence)

        answer = self.answer_generator.generate(
            question=clean_question,
            evidence=evidence,
        )

        self.context_manager.add_turn(
            question=clean_question,
            answer=answer,
            entities=validated_plan.get("entities", []),
        )

        all_sources: list[dict[str, Any]] = []

        for postgres_result in postgres_results:
            all_sources.extend(
                postgres_result.get("sources", [])
            )

        if security_result is not None:
            all_sources.extend(
                security_result.get("sources", [])
            )

        if len(retrieval_contracts) == 1:
            retrieval_contract_output = next(
                iter(retrieval_contracts.values())
            )
        else:
            retrieval_contract_output = retrieval_contracts

        result: dict[str, Any] = {
            "question": clean_question,
            "plan": validated_plan,
            "plan_repaired": plan_repaired,
            "data_sources": data_sources,
            "security_resource": security_resource,
            "postgresql_source_ids": postgresql_sources,
            "workspace_scoped": bool(
                workspace_id
                and security_resource in {
                    "workspace_security_logs",
                    "workspace_siem_status",
                }
            ),
            "retrieval_contract": retrieval_contract_output,
            "evidence": evidence,
            "answer": answer,
            "sources": all_sources,
            "source_status": source_status,
            "retrieval_status": overall_retrieval_status,
        }

        if len(postgres_results) == 1:
            postgres_result = postgres_results[0]
            result["sql"] = postgres_result.get("sql")
            result["postgresql_retrieval"] = postgres_result.get(
                "retrieval",
                {},
            )
            result["postgresql_sources"] = postgres_result.get(
                "sources",
                [],
            )
            result["sql_repaired"] = postgres_result.get(
                "repaired",
                False,
            )

        elif len(postgres_results) > 1:
            result["sql_by_source"] = {
                postgres_result["source_id"]: postgres_result.get("sql")
                for postgres_result in postgres_results
            }

            result["postgresql_retrievals"] = {
                postgres_result["source_id"]: postgres_result.get(
                    "retrieval",
                    {},
                )
                for postgres_result in postgres_results
            }

            result["postgresql_sources"] = []

            for postgres_result in postgres_results:
                result["postgresql_sources"].extend(
                    postgres_result.get("sources", [])
                )

            result["sql_repaired"] = {
                postgres_result["source_id"]: postgres_result.get(
                    "repaired",
                    False,
                )
                for postgres_result in postgres_results
            }

        if security_result is not None:
            result["security_logs_retrieval"] = security_result.get(
                "retrieval",
                {},
            )
            result["security_logs_sources"] = security_result.get(
                "sources",
                [],
            )
            result["security_logs_retrieval_status"] = security_result.get(
                "retrieval_status"
            )
            result["security_logs_error"] = security_result.get(
                "error"
            )

        return sanitize_api_response(result)

