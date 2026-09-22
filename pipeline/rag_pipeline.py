from copy import deepcopy

from typing import Any

from psycopg2 import errors

from context.context_manager import ContextManager

from security.output_security_policy import (
sanitize_api_response,
sanitize_evidence,
)

from context.context_store import (
    load_all_contexts,
    load_context,
)

from entity_resolution.entity_normalizer import (
    normalize_entity_candidates,
)

from entity_resolution.entity_resolver import EntityResolver

from entity_resolution.entity_search import (
    extract_entity_search_text,
)

from entity_resolution.entity_selector import select_entity

from llm.answer_generator import AnswerGenerator

from llm.evidence_manager import EvidenceManager

from planning.question_plan_validator import QuestionPlanValidator

from planning.question_planner import QuestionPlanner

from retrieval.retrieval_contract import (
    create_retrieval_contract,
)

from retrieval.retrieval_executor import RetrievalExecutor

from retrieval.sql_generator import SQLGenerator

from security.evidence_security import (
    sanitize_api_response,
    sanitize_evidence,
)

from security_logs.retriever import SecurityLogRetriever

from tracing.source_tracker import SourceTracker


class RAGPipeline:
    """
    Orchestrate dynamic question planning and live retrieval.

    Available retrieval sources:

    - PostgreSQL through the strictly read-only RetrievalExecutor.
    - Security/SIEM logs through SecurityLogRetriever.

    No database schema, entity name, table name, column name,
    or business relationship is hardcoded here.
    """

    SQL_REPAIR_ERRORS = (
        errors.GroupingError,
        errors.DatatypeMismatch,
        errors.UndefinedColumn,
        errors.UndefinedTable,
        errors.InvalidTextRepresentation,
        errors.UndefinedFunction,
    )

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    ALLOWED_SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
    }

    DEFAULT_SECURITY_RESOURCE = "security_logs"

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

        # PostgreSQL retrieval
        # SQL generators are created per PostgreSQL source so that
        # each generator uses the correct discovered Context Layer.
        self.sql_generators: dict[str, SQLGenerator] = {}

        self.executor = RetrievalExecutor()

        self.source_tracker = SourceTracker()

        # Security/SIEM retrieval
        self.security_log_retriever = SecurityLogRetriever()

        # Evidence and answer generation
        self.evidence_manager = EvidenceManager()

        self.answer_generator = AnswerGenerator()

    # --------------------------------------------------
    # Input validation
    # --------------------------------------------------

    def _validate_question(
        self,
        question: str,
    ) -> str:

        if not isinstance(question, str):
            raise ValueError("Question must be a string.")

        question = question.strip()

        if not question:
            raise ValueError("Question cannot be empty.")

        # Prevent unnecessarily large prompts from entering
        # the planning/retrieval pipeline.
        if len(question) > 4000:
            raise ValueError(
                "Question is too long. "
                "Please keep it under 4000 characters."
            )

        return question

    # --------------------------------------------------
    # Conversation context
    # --------------------------------------------------

    def _get_conversation_context(
        self,
    ) -> dict[str, Any]:

        return {
            "history": self.context_manager.get_history(),
            "entities": self.context_manager.get_entities(),
        }

    # --------------------------------------------------
    # Entity resolution
    # --------------------------------------------------

    def _resolve_entity(
        self,
        question: str,
        conversation_context: dict[str, Any],
    ) -> None:

        search_text = extract_entity_search_text(question)

        if not search_text:
            return

        candidates = self.entity_resolver.resolve(
            search_text
        )

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
    # Data-source validation
    # --------------------------------------------------

    def _get_data_sources(
        self,
        plan: dict[str, Any],
    ) -> list[str]:

        data_sources = plan.get(
            "data_sources",
            ["postgresql"],
        )

        if not isinstance(
            data_sources,
            list,
        ):
            raise ValueError(
                "Question plan data_sources must be a list."
            )

        if not data_sources:
            raise ValueError(
                "Question plan did not select a data source."
            )

        invalid_sources = [
            source
            for source in data_sources
            if source not in self.ALLOWED_DATA_SOURCES
        ]

        if invalid_sources:
            raise ValueError(
                "Question plan selected unsupported "
                f"data source(s): {invalid_sources}"
            )

        # Preserve planner order while removing duplicates.
        return list(dict.fromkeys(data_sources))

    # --------------------------------------------------
    # Security-resource validation
    # --------------------------------------------------

    def _get_security_resource(
        self,
        plan: dict[str, Any],
        data_sources: list[str],
    ) -> str | None:
        """
        Return the validated security resource selected by the
        question planner.

        The LLM selects only the logical resource name.

        API URLs, authentication headers, bearer tokens, and
        workspace identifiers are never generated here by the LLM.
        """

        if "security_logs" not in data_sources:
            return None

        resource = plan.get(
            "security_resource",
            self.DEFAULT_SECURITY_RESOURCE,
        )

        if resource is None:
            resource = self.DEFAULT_SECURITY_RESOURCE

        if not isinstance(
            resource,
            str,
        ):
            raise ValueError(
                "Question plan security_resource must be a string."
            )

        resource = resource.strip()

        if not resource:
            resource = self.DEFAULT_SECURITY_RESOURCE

        if resource not in self.ALLOWED_SECURITY_RESOURCES:
            raise ValueError(
                "Question plan selected unsupported "
                f"security resource: {resource!r}"
            )

        return resource

    # --------------------------------------------------
    # PostgreSQL source validation
    # --------------------------------------------------

    def _get_postgresql_sources(
        self,
        plan: dict[str, Any],
    ) -> list[str]:
        """
        Return the PostgreSQL Context Layer source IDs selected
        by the validated question plan.

        Source IDs must come from the discovered Context Layer.
        """

        sources = plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(
            sources,
            list,
        ):
            raise ValueError(
                "Question plan postgresql_sources must be a list."
            )

        sources = list(
            dict.fromkeys(sources)
        )

        if "postgresql" not in plan.get(
            "data_sources",
            [],
        ):
            return []

        if not sources:
            raise ValueError(
                "PostgreSQL was selected but no PostgreSQL "
                "source was specified."
            )

        available_sources = set(
            load_all_contexts().keys()
        )

        invalid_sources = [
            source
            for source in sources
            if source not in available_sources
        ]

        if invalid_sources:
            raise ValueError(
                "Question plan selected unavailable PostgreSQL "
                f"source(s): {invalid_sources}"
            )

        return sources

    # --------------------------------------------------
    # Source-specific SQL generator
    # --------------------------------------------------

    def _get_sql_generator(
        self,
        source_id: str,
    ) -> SQLGenerator:
        """
        Return a SQL generator configured for one PostgreSQL source.
        """

        if source_id not in self.sql_generators:
            self.sql_generators[source_id] = SQLGenerator(
                source_id=source_id
            )

        return self.sql_generators[source_id]

    # --------------------------------------------------
    # Source-specific retrieval plan
    # --------------------------------------------------

    def _build_source_validation(
        self,
        validation: dict[str, Any],
        source_id: str,
        total_selected_sources: int,
    ) -> dict[str, Any] | None:
        """
        Create a source-specific validation payload.

        This allows DB1 and DB2 to be retrieved independently.

        Tables, columns, and relationships are filtered using the
        dynamically discovered source Context Layer.

        No table or column names are hardcoded.
        """

        source_context = load_context(
            source_id=source_id
        )

        known_tables = set(
            source_context.get(
                "tables",
                {},
            ).keys()
        )

        known_columns: dict[str, set[str]] = {}

        for (
            table_name,
            table_info,
        ) in source_context.get(
            "tables",
            {},
        ).items():

            known_columns[table_name] = {
                column.get("name")
                for column in table_info.get(
                    "columns",
                    [],
                )
                if (
                    isinstance(column, dict)
                    and column.get("name")
                )
            }

        source_plan = deepcopy(
            validation["plan"]
        )

        required_tables = source_plan.get(
            "required_tables",
            [],
        )

        required_columns = source_plan.get(
            "required_columns",
            [],
        )

        relationships = source_plan.get(
            "relationships",
            [],
        )

        # Only tables that actually exist in this source.
        source_tables = [
            table
            for table in required_tables
            if (
                isinstance(table, str)
                and table in known_tables
            )
        ]

        # Only columns belonging to tables available in this source.
        source_columns = []

        for column_reference in required_columns:

            if not isinstance(
                column_reference,
                str,
            ):
                continue

            if "." not in column_reference:
                continue

            table_name, column_name = (
                column_reference.split(".", 1)
            )

            if (
                table_name in source_tables
                and column_name
                in known_columns.get(
                    table_name,
                    set(),
                )
            ):
                source_columns.append(
                    column_reference
                )

        # Only relationships entirely inside this PostgreSQL source.
        source_relationships = []

        for relationship in relationships:

            if not isinstance(
                relationship,
                dict,
            ):
                continue

            source_table = relationship.get(
                "source_table"
            )

            target_table = relationship.get(
                "target_table"
            )

            if (
                source_table in source_tables
                and target_table in source_tables
            ):
                source_relationships.append(
                    relationship
                )

        source_plan["data_sources"] = [
            "postgresql"
        ]

        source_plan["postgresql_sources"] = [
            source_id
        ]

        source_plan["required_tables"] = (
            source_tables
        )

        source_plan["required_columns"] = (
            source_columns
        )

        source_plan["relationships"] = (
            source_relationships
        )

        # If this source has no relevant table, don't execute SQL
        # against it. This is especially useful when multiple sources
        # were selected.
        if (
            required_tables
            and not source_tables
        ):

            if total_selected_sources == 1:
                raise ValueError(
                    "The selected PostgreSQL source does not contain "
                    "the required tables."
                )

            return None

        source_validation = deepcopy(
            validation
        )

        source_validation["valid"] = True

        source_validation["errors"] = []

        source_validation["plan"] = source_plan

        return source_validation

    # --------------------------------------------------
    # PostgreSQL retrieval
    # --------------------------------------------------

    def _retrieve_postgresql(
        self,
        contract_dict: dict[str, Any],
        source_id: str,
    ) -> dict[str, Any]:

        if not source_id:
            raise ValueError(
                "PostgreSQL source_id cannot be empty."
            )

        sql_generator = self._get_sql_generator(
            source_id
        )

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

        return {
            "source_type": "postgresql",
            "source_id": source_id,
            "retrieval": retrieval,
            "sql": sql,
            "repaired": repaired,
            "sources": source,
        }

    # --------------------------------------------------
    # Security/SIEM retrieval
    # --------------------------------------------------

    def _retrieve_security_logs(
        self,
        plan: dict[str, Any],
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Retrieve from the security resource selected by the
        validated question plan.

        The planner only selects a logical resource.

        Runtime configuration remains responsible for:

        - API base URL
        - authentication
        - bearer token
        - request headers
        - workspace_id

        The LLM never supplies those values.
        """

        resource = plan.get(
            "security_resource",
            self.DEFAULT_SECURITY_RESOURCE,
        )

        if resource is None:
            resource = self.DEFAULT_SECURITY_RESOURCE

        if not isinstance(
            resource,
            str,
        ):
            raise ValueError(
                "security_resource must be a string."
            )

        resource = resource.strip()

        if not resource:
            resource = self.DEFAULT_SECURITY_RESOURCE

        if resource not in self.ALLOWED_SECURITY_RESOURCES:
            raise ValueError(
                "Unsupported security resource: "
                f"{resource!r}"
            )

        limit = plan.get("limit")

        if (
            not isinstance(limit, int)
            or limit <= 0
        ):
            limit = 100

        # --------------------------------------------------
        # General security logs
        # --------------------------------------------------

        if resource == "security_logs":

            security_retrieval = (
                self.security_log_retriever.retrieve(
                    limit=limit,
                )
            )

        # --------------------------------------------------
        # CLI / Git / shell / audit logs
        # --------------------------------------------------

        elif resource == "cli_audit_logs":

            retriever_method = getattr(
                self.security_log_retriever,
                "retrieve_cli_audit_logs",
                None,
            )

            if not callable(retriever_method):
                raise RuntimeError(
                    "SecurityLogRetriever does not expose "
                    "retrieve_cli_audit_logs()."
                )

            security_retrieval = retriever_method(
                limit=limit,
            )

        # --------------------------------------------------
        # Security-log summary
        # --------------------------------------------------

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

        # --------------------------------------------------
        # Workspace security logs
        # --------------------------------------------------

        elif resource == "workspace_security_logs":

            if not workspace_id:
                raise ValueError(
                    "workspace_id is required for "
                    "workspace_security_logs."
                )

            security_retrieval = (
                self.security_log_retriever
                .retrieve_workspace_security_logs(
                    workspace_id=workspace_id,
                    limit=limit,
                )
            )

        # --------------------------------------------------
        # Workspace SIEM status
        # --------------------------------------------------

        elif resource == "workspace_siem_status":

            if not workspace_id:
                raise ValueError(
                    "workspace_id is required for "
                    "workspace_siem_status."
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

        # --------------------------------------------------
        # Security overview
        # --------------------------------------------------

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

            # This should already be prevented by the validation above.
            raise ValueError(
                "Unsupported security resource: "
                f"{resource!r}"
            )

        if not isinstance(
            security_retrieval,
            dict,
        ):
            raise ValueError(
                "SecurityLogRetriever must return a dictionary."
            )

        events = security_retrieval.get(
            "events",
            [],
        )

        if not isinstance(
            events,
            list,
        ):
            events = []

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

            source["workspace_id"] = (
                security_retrieval["workspace_id"]
            )

        if "retrieved_at" in security_retrieval:

            source["retrieved_at"] = (
                security_retrieval["retrieved_at"]
            )

        if "events" in security_retrieval:

            source["event_count"] = len(events)

        return {
            "source_type": "security_logs_api",
            "resource": resource,
            "retrieval": security_retrieval,
            "sources": [source],
        }

    # --------------------------------------------------
    # Evidence preparation
    # --------------------------------------------------

    def _prepare_evidence(
        self,
        postgres_results: list[dict[str, Any]],
        security_result: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """
        Normalize evidence from all selected sources.

        PostgreSQL sources are retrieved independently and their
        bounded results are combined only at the evidence layer.

        No cross-database SQL is generated.
        """

        evidence: dict[str, Any] = {
            "sources": [],
        }

        # ------------------------------
        # PostgreSQL evidence
        # ------------------------------

        if postgres_results:

            combined_rows: list[dict[str, Any]] = []

            combined_columns: list[str] = []

            combined_provenance: list[dict[str, Any]] = []

            for postgres_result in postgres_results:

                retrieval = postgres_result.get(
                    "retrieval",
                    {},
                )

                rows = retrieval.get(
                    "rows",
                    [],
                )

                if isinstance(
                    rows,
                    list,
                ):
                    combined_rows.extend(rows)

                columns = retrieval.get(
                    "columns",
                    [],
                )

                if isinstance(
                    columns,
                    list,
                ):

                    for column in columns:

                        if column not in combined_columns:

                            combined_columns.append(
                                column
                            )

                provenance = retrieval.get(
                    "provenance"
                )

                if isinstance(
                    provenance,
                    dict,
                ):

                    combined_provenance.append(
                        provenance
                    )

                evidence["sources"].extend(
                    postgres_result.get(
                        "sources",
                        [],
                    )
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
                    postgres_result.get(
                        "sources",
                        [],
                    )
                )

            postgres_evidence = (
                self.evidence_manager.prepare(
                    retrieval=combined_retrieval,
                    sources=combined_sources,
                )
            )

            evidence["postgresql"] = (
                postgres_evidence
            )

        # ------------------------------
        # Security/SIEM evidence
        # ------------------------------

        if security_result is not None:

            security_retrieval = (
                security_result.get(
                    "retrieval",
                    {},
                )
            )

            security_sources = (
                security_result.get(
                    "sources",
                    [],
                )
            )

            # Keep the complete security retrieval payload so
            # summary/status/overview resources are not reduced
            # to "events" only.
            evidence["security_logs"] = {
                "source_type": "security_logs_api",
                "resource": security_result.get(
                    "resource"
                ),
                "retrieval": security_retrieval,
            }

            evidence["sources"].extend(
                security_sources
            )

        return evidence

    # --------------------------------------------------
    # Retrieval status
    # --------------------------------------------------

    def _has_retrieved_data(
        self,
        postgres_results: list[dict[str, Any]],
        security_result: dict[str, Any] | None,
    ) -> bool:

        for postgres_result in postgres_results:

            retrieval = postgres_result.get(
                "retrieval",
                {},
            )

            rows = retrieval.get(
                "rows",
                [],
            )

            if rows:
                return True

        if security_result is not None:

            retrieval = security_result.get(
                "retrieval",
                {},
            )

            events = retrieval.get(
                "events"
            )

            if isinstance(
                events,
                list,
            ) and events:

                return True

            # Some security resources return structured
            # data instead of an events list.
            data = retrieval.get(
                "data"
            )

            if data not in (
                None,
                {},
                [],
                "",
            ):

                return True

            # Also support direct summary/status/overview
            # payloads where the retriever returns the useful
            # values at the top level.
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
                and value not in (
                    None,
                    {},
                    [],
                    "",
                )
            }

            if meaningful_keys:
                return True

        return False

    # --------------------------------------------------
    # Workspace ID validation
    # --------------------------------------------------

    def _validate_workspace_id(
        self,
        workspace_id: str | None,
    ) -> str | None:
        """
        Normalize a runtime workspace ID.

        The workspace ID is not generated by the LLM.

        It must be supplied by the trusted application/request
        context when a workspace-scoped security operation is
        required.
        """

        if workspace_id is None:
            return None

        if not isinstance(
            workspace_id,
            str,
        ):
            raise ValueError(
                "workspace_id must be a string or null."
            )

        workspace_id = workspace_id.strip()

        if not workspace_id:
            return None

        if len(workspace_id) > 256:
            raise ValueError(
                "workspace_id is too long."
            )

        return workspace_id

    # --------------------------------------------------
    # Execution Pipeline
    # --------------------------------------------------

    def ask(
        self,
        question: str,
        workspace_id: str | None = None,
    ) -> dict[str, Any]:

        # 1. Input validation
        clean_question = self._validate_question(
            question
        )

        workspace_id = self._validate_workspace_id(
            workspace_id
        )

        # 2. Conversation context
        conversation_context = (
            self._get_conversation_context()
        )

        # 3. Entity resolution
        self._resolve_entity(
            clean_question,
            conversation_context,
        )

        # 4. Question planning
        raw_plan = self.planner.plan(
            question=clean_question,
            conversation_context=conversation_context,
        )

        # 5. Question plan validation + one repair attempt
        validation = self.plan_validator.validate(
            raw_plan
        )

        plan_repaired = False

        if not validation.get(
            "valid",
            False,
        ):

            validation_errors = validation.get(
                "errors",
                [],
            )

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

            repaired_validation = (
                self.plan_validator.validate(
                    repaired_plan
                )
            )

            if not repaired_validation.get(
                "valid",
                False,
            ):

                print(
                    "QUESTION PLAN REPAIR FAILED."
                )

                raise ValueError(
                    "Question plan could not be validated after one "
                    "schema-based repair attempt."
                )

            validation = repaired_validation

            plan_repaired = True

        validated_plan = validation["plan"]

        # 6. Data source validation
        data_sources = self._get_data_sources(
            validated_plan
        )

        # 6b. Security resource validation
        security_resource = self._get_security_resource(
            validated_plan,
            data_sources,
        )

        # Make the normalized resource explicit in the
        # execution plan.
        validated_plan["security_resource"] = (
            security_resource
        )

        # ----------------------------------------------
        # 7. Determine PostgreSQL source(s)
        # ----------------------------------------------

        postgresql_sources = (
            self._get_postgresql_sources(
                validated_plan
            )
        )

        print(
            "SELECTED POSTGRESQL SOURCES:",
            postgresql_sources,
        )

        print(
            "SELECTED SECURITY RESOURCE:",
            security_resource,
        )

        # ----------------------------------------------
        # 8. Create source-specific retrieval contracts
        # ----------------------------------------------

        postgres_results: list[dict[str, Any]] = []

        retrieval_contracts: dict[
            str,
            dict[str, Any],
        ] = {}

        if postgresql_sources:

            total_selected_sources = len(
                postgresql_sources
            )

            for source_id in postgresql_sources:

                source_validation = (
                    self._build_source_validation(
                        validation=validation,
                        source_id=source_id,
                        total_selected_sources=(
                            total_selected_sources
                        ),
                    )
                )

                if source_validation is None:
                    continue

                contract = create_retrieval_contract(
                    source_validation
                )

                source_contract_dict = (
                    contract.to_dict()
                )

                retrieval_contracts[
                    source_id
                ] = source_contract_dict

                postgres_result = (
                    self._retrieve_postgresql(
                        contract_dict=source_contract_dict,
                        source_id=source_id,
                    )
                )

                postgres_results.append(
                    postgres_result
                )

            if not postgres_results:

                raise ValueError(
                    "No selected PostgreSQL source contained "
                    "the required retrieval context."
                )

        # ----------------------------------------------
        # 9. Retrieve Security/SIEM resource if required
        # ----------------------------------------------

        security_result = None

        if "security_logs" in data_sources:

            security_result = (
                self._retrieve_security_logs(
                    plan=validated_plan,
                    workspace_id=workspace_id,
                )
            )

        # ----------------------------------------------
        # 10. Prepare combined evidence
        # ----------------------------------------------

        evidence = self._prepare_evidence(
            postgres_results=postgres_results,
            security_result=security_result,
        )

        # Security boundary:
        # protect retrieved evidence before it reaches
        # the LLM.
        evidence = sanitize_evidence(
            evidence
        )

        # ----------------------------------------------
        # 11. Evaluate data existence
        # ----------------------------------------------

        has_data = self._has_retrieved_data(
            postgres_results=postgres_results,
            security_result=security_result,
        )

        # ----------------------------------------------
        # 12. Generate answer
        # ----------------------------------------------

        answer = self.answer_generator.generate(
            question=clean_question,
            evidence=evidence,
        )

        # ----------------------------------------------
        # 13. Persist conversation turn
        # ----------------------------------------------

        self.context_manager.add_turn(
            question=clean_question,
            answer=answer,
            entities=validated_plan.get(
                "entities",
                [],
            ),
        )

        # ----------------------------------------------
        # 14. Build response
        # ----------------------------------------------

        all_sources: list[dict[str, Any]] = []

        for postgres_result in postgres_results:

            all_sources.extend(
                postgres_result.get(
                    "sources",
                    [],
                )
            )

        if security_result is not None:

            all_sources.extend(
                security_result.get(
                    "sources",
                    [],
                )
            )

        # Preserve the old single-source contract shape,
        # while exposing a source->contract mapping for
        # multiple PostgreSQL sources.
        if len(retrieval_contracts) == 1:

            retrieval_contract_output = (
                next(
                    iter(
                        retrieval_contracts.values()
                    )
                )
            )

        else:

            retrieval_contract_output = (
                retrieval_contracts
            )

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
            "retrieval_status": (
                "success_with_data"
                if has_data
                else "success_empty"
            ),
        }

        # ----------------------------------------------
        # PostgreSQL response details
        # ----------------------------------------------

        if len(postgres_results) == 1:

            postgres_result = postgres_results[0]

            result["sql"] = postgres_result["sql"]

            result["postgresql_retrieval"] = (
                postgres_result["retrieval"]
            )

            result["postgresql_sources"] = (
                postgres_result["sources"]
            )

            result["sql_repaired"] = (
                postgres_result["repaired"]
            )

        elif len(postgres_results) > 1:

            result["sql_by_source"] = {
                postgres_result["source_id"]: (
                    postgres_result["sql"]
                )
                for postgres_result in postgres_results
            }

            result["postgresql_retrievals"] = {
                postgres_result["source_id"]: (
                    postgres_result["retrieval"]
                )
                for postgres_result in postgres_results
            }

            result["postgresql_sources"] = []

            for postgres_result in postgres_results:

                result["postgresql_sources"].extend(
                    postgres_result.get(
                        "sources",
                        []
                    )
                )

            result["sql_repaired"] = {
                postgres_result["source_id"]: (
                    postgres_result["repaired"]
                )
                for postgres_result in postgres_results
            }

        # ----------------------------------------------
        # Security-log response details
        # ----------------------------------------------

        if security_result is not None:

            result["security_logs_retrieval"] = (
                security_result["retrieval"]
            )

            result["security_logs_sources"] = (
                security_result["sources"]
            )

        # ----------------------------------------------
        # Final API security boundary
        # ----------------------------------------------
        #
        # Protect raw retrieval/evidence payloads before
        # they are returned to the frontend/API consumer.
        #
        # This does not modify PostgreSQL or any source.
        #
        return sanitize_api_response(result)
