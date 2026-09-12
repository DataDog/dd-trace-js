from common import finish
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from parity_langchain import chat_openai, start


@tool
def add(a: int, b: int) -> str:
    """Adds two numbers together"""
    return str(a + b)


start()
agent = create_react_agent(
    chat_openai(temperature=0.5),
    tools=[add],
    name="parity_agent",
    prompt="You are a helpful assistant.",
)
agent.invoke({"messages": [{"role": "user", "content": "What is 2 + 2?"}]})
finish()
