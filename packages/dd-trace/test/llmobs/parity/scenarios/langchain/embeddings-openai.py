from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
openai_embeddings().embed_query("Embed this parity text.")
finish()
