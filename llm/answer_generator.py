from typing import Any

from llm.openai_client import get_openai_client


class AnswerGenerator:
    """
    Generate a grounded answer from retrieved evidence.

    The model is allowed to use only the evidence supplied
    by the retrieval layer.
    """

    def __init__(self):
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

Rules:
1. Do not invent facts.
2. Do not use information outside the evidence.
3. If the evidence is insufficient, say so clearly.
4. Do not claim a record exists unless it appears in the evidence.
5. Keep the answer concise and directly answer the question.
6. When useful, mention the source table/entity.
7. Do not expose internal reasoning.
8. If the evidence was truncated, answer only from the evidence provided.
9. Use normal paragraphs or simple bullet points for the answer.
10. Do NOT use Markdown tables.
11. Never format retrieved records as a table.
12. When multiple records need to be shown, use bullet points instead.
13. Keep each record on a separate bullet point when appropriate.
14. Use simple readable text rather than complex Markdown formatting.
15. Do not escape pipe characters such as \|.
16. Do not put multiple records on one line.
17. Preserve line breaks between paragraphs and bullet points.

USER QUESTION:{question}

RETRIEVED EVIDENCE:{evidence}
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
            model="gpt-5.6-terra",
            input=prompt,
        )

        answer = response.output_text.strip()

        if not answer:
            raise ValueError(
                "Answer generator returned an empty response."
            )

        return answer