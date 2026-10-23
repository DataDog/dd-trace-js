from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
for _chunk in chat_openai(temperature=0, max_tokens=16).stream([("user", "Stream a short parity response.")]):
    pass
finish()
