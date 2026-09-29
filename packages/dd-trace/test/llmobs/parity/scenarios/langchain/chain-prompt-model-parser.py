from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate

prompt = ChatPromptTemplate.from_messages([("system", "You are a parity assistant."), ("human", "{input}")])
chain = prompt | chat_openai(temperature=0, max_tokens=16) | StrOutputParser()
chain.invoke({"input": "Hello from the parity harness."})
finish()
