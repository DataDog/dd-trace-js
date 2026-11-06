from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
try:
    chat_openai(temperature=0, max_retries=0).invoke([("user", "This request fails.")])
except Exception:
    pass  # expected: the stub returns a 400
finish()
