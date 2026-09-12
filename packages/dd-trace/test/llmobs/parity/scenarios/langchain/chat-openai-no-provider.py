from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start(providers=False)
chat_openai(temperature=0, max_tokens=16).invoke([("user", "Hello from the parity harness.")])
finish()
