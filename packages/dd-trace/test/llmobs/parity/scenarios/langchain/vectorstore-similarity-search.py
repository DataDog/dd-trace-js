from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore

store = InMemoryVectorStore(openai_embeddings())
store.add_documents(
    [
        Document(page_content="Parity document one.", id="doc-1", metadata={"source": "one.txt"}),
        Document(page_content="Parity document two.", id="doc-2", metadata={"source": "two.txt"}),
    ]
)
store.similarity_search("parity", k=2)
finish()
