"""Shared helpers for the LangChain / LangGraph parity scenarios.

Lives at the scenarios root (not under ``scenarios/langchain``) because that folder name would shadow the
``langchain`` package on ``PYTHONPATH``.
"""

import os

from ddtrace import patch
from ddtrace.llmobs import LLMObs


def start(providers=True):
    """``LLMObs.enable`` patches every supported LLM integration by default (the provider integrations included),
    so the default scenario shape has the LangChain model span demoted to a workflow wrapping the provider span.
    ``providers=False`` mirrors a user that only patched LangChain."""
    patch(langchain=True, langgraph=True)
    LLMObs.enable(agentless_enabled=False, integrations_enabled=providers)


def chat_openai(**kwargs):
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model="gpt-4o-mini",
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=f"{os.environ['PROVIDER_BASE_URL']}/v1",
        **kwargs,
    )


def openai_embeddings(**kwargs):
    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(
        model="text-embedding-3-small",
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=f"{os.environ['PROVIDER_BASE_URL']}/v1",
        check_embedding_ctx_length=False,
        **kwargs,
    )


def chat_anthropic(**kwargs):
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model="claude-3-5-sonnet-20241022",
        api_key=os.environ["ANTHROPIC_API_KEY"],
        base_url=os.environ["PROVIDER_BASE_URL"],
        **kwargs,
    )
