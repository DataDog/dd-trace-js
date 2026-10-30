from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
from langchain_core.tools import tool


@tool
def add(a: int, b: int) -> str:
    """Adds two numbers together"""
    return str(a + b)


add.invoke({"a": 2, "b": 2})
finish()
