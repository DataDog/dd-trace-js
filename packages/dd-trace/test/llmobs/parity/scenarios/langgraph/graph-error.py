import operator
from typing import Annotated, TypedDict

from common import finish
from langgraph.graph import END, START, StateGraph
from parity_langchain import chat_openai, start  # noqa: F401


class State(TypedDict):
    steps: Annotated[list, operator.add]


def agent_a(state):
    return {"steps": ["a"]}


def agent_b(state):
    return {"steps": ["b"]}


def build_graph():
    graph = StateGraph(State)
    graph.add_node("agent_a", agent_a)
    graph.add_node("agent_b", agent_b)
    graph.add_edge(START, "agent_a")
    graph.add_edge("agent_a", "agent_b")
    graph.add_edge("agent_b", END)
    return graph.compile(name="ParityGraph")


start()
def agent_fails(state):
    raise ValueError("parity node failure")


graph = StateGraph(State)
graph.add_node("agent_a", agent_a)
graph.add_node("agent_fails", agent_fails)
graph.add_edge(START, "agent_a")
graph.add_edge("agent_a", "agent_fails")
graph.add_edge("agent_fails", END)
try:
    graph.compile(name="ParityGraph").invoke({"steps": []})
except ValueError:
    pass  # expected
finish()
