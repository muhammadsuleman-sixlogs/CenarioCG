from __future__ import annotations

from typing import Any

from llm.openai_client import OPENAI_MODEL, get_openai_client
from security.output_security_policy import validate_output_text


class AnswerGenerator:
    """
    Generate a grounded answer from retrieved evidence.

    The model is allowed to use only the evidence supplied
    by the retrieval layer.

    Evidence may come from:
    - PostgreSQL
    - Security/SIEM logs
    - Both sources

    The final generated answer is also checked by the
    output-security policy before being returned.
    """

    def __init__(self) -> None:
        self.client = get_openai_client()

    def build_prompt(
        self,
        question: str,
        evidence: dict[str, Any],
    ) -> str:

        if not question or not question.strip():
            raise ValueError("Question cannot be empty.")

        if not isinstance(evidence, dict):
            raise ValueError("Evidence must be a dictionary.")

        return f"""
You are a grounded data assistant.

Answer the user's question using ONLY the retrieved evidence below.

The evidence may contain:

- PostgreSQL records from the company's live database.
- Security/SIEM events from the security logs API.
- Evidence from both sources.

Rules:

1. Do not invent facts.

2. Do not use information outside the retrieved evidence.

3. If the evidence is insufficient to answer the question, say so clearly.

4. Do not claim that a record, event, entity, relationship, or value exists
   unless it appears in the retrieved evidence.

5. Keep the answer concise and directly answer the user's question.

6. When useful, identify whether the information came from PostgreSQL
   or security/SIEM logs.

7. Do not expose internal reasoning, chain-of-thought, or hidden analysis.

8. If the evidence was truncated, answer only from the evidence that was
   actually provided.

9. Use normal paragraphs or simple bullet points.

10. Do NOT use Markdown tables.

11. Never format retrieved records as a table.

12. When multiple records or events need to be shown, use bullet points.

13. Keep each record or event on a separate bullet point when appropriate.

14. Use simple, readable Markdown.

15. Do not escape pipe characters such as \\|.

16. Do not put multiple retrieved records or events on one line.

17. Preserve line breaks between paragraphs and bullet points.

18. Do not assume that an empty result means that the requested entity,
    event, or activity does not exist unless the retrieved evidence
    explicitly supports that conclusion.

19. If PostgreSQL and security-log evidence are both provided, use only
    the evidence relevant to the question and clearly distinguish the
    sources when necessary.

20. Never combine information from different sources in a way that creates
    a fact that is not directly supported by the retrieved evidence.

21. Never reveal passwords, secrets, API keys, access tokens, refresh tokens,
    bearer tokens, private keys, client secrets, credentials, or other
    credential-like values, even if they appear in the retrieved evidence.

22. If the retrieved evidence contains credential-like information,
    do not reproduce that information in the answer.

23. Do not reveal sensitive credential material by paraphrasing,
    transforming, encoding, or partially reproducing it.

24. Answer the user's question as a helpful human-facing AI assistant,
    not as a database result formatter.

25. Do not simply copy or dump retrieved rows.

26. Translate structured database evidence into natural, readable language.

27. Include only the records, fields, and facts that are relevant to
    answering the user's question.

28. Do not list unrelated records just because they appear in the evidence.

29. Do not expose database column names, internal implementation details,
    SQL, or raw JSON unless the user explicitly asks for them.

30. Do not expose internal UUIDs or technical identifiers unless they are
    necessary to answer the question or the user explicitly asks for them.

31. When the user asks for a relationship between entities, clearly state
    the relationship in natural language.

32. When multiple records answer the question, summarize them naturally
    and use a short bullet list when appropriate.

33. When a count can be directly determined from the evidence, provide
    the count naturally.

34. Start with the direct answer. Do not begin with phrases such as
    "Retrieved evidence:", "Database results:", or "According to the
    records:" unless the source itself is relevant to the question.

35. If the user asks a simple factual question, prefer a short,
    conversational answer over a long data dump.

36. If the user asks for details, provide the relevant details while
    still avoiding unrelated retrieved data.

37. Preserve the exact meaning of the evidence. Natural-language
    rewriting must not introduce new facts or assumptions.

38. If the evidence contains multiple possible interpretations, explain
    the ambiguity rather than choosing an unsupported interpretation.

USER QUESTION:

{question}

RETRIEVED EVIDENCE:

{evidence}

""".strip()

    def generate(
        self,
        question: str,
        evidence: dict[str, Any],
    ) -> str:

        prompt = self.build_prompt(
            question=question,
            evidence=evidence,
        )

        response = self.client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
        )

        answer = (
            response.output_text
            if response.output_text is not None
            else ""
        ).strip()

        if not answer:
            raise ValueError(
                "Answer generator returned an empty response."
            )

        # ---------------------------------------------------------
        # FINAL OUTPUT SECURITY CHECK
        # ---------------------------------------------------------
        #
        # The LLM is instructed not to expose credentials, but
        # instructions alone are not sufficient. Validate the
        # actual generated response before returning it.
        #
        validate_output_text(answer)

        return answer