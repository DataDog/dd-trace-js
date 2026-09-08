import os

os.environ["DD_TRACE_MCP_ENABLED"] = "0"

from agents import Agent
from agents import Runner
from agents import function_tool
from agents import input_guardrail
from agents import output_guardrail
from openai import AsyncOpenAI
from agents import set_default_openai_client

from common import finish, start


def setup(chat_api=False):
    start("openai_agents")
    if chat_api:
        from agents import set_default_openai_api

        set_default_openai_api("chat_completions")
    set_default_openai_client(
        AsyncOpenAI(base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1', api_key="x")
    )


@function_tool(name_override="add")
def add(a: int, b: int) -> int:
    """Add two numbers together"""
    return a + b


@function_tool(name_override="add")
def add_with_error(a: int, b: int) -> int:
    """Add two numbers together"""
    raise ValueError("This is a test error")


@function_tool
def research(query: str) -> str:
    """Research the internet on a topic."""
    return (
        "united beat liverpool 2-1 yesterday. "
        "also a lot of other stuff happened. "
        "like super important stuff. "
        "blah blah blah."
    )


def simple_agent():
    return Agent(
        name="Simple Agent",
        instructions="You are a helpful assistant who answers questions concisely and accurately.",
        model="gpt-4o",
    )


def addition_agent():
    return Agent(
        name="Addition Agent",
        instructions="You are a helpful assistant specialized in addition calculations.",
        tools=[add],
        model="gpt-4o",
    )


def addition_agent_with_tool_errors():
    return Agent(
        name="Addition Agent",
        instructions=(
            "You are a helpful assistant specialized in addition calculations. "
            "Do not retry the tool call if it errors and instead return immediately"
        ),
        tools=[add_with_error],
        model="gpt-4o",
    )


def research_workflow():
    summarizer = Agent(
        name="Summarizer",
        instructions="You are a helpful assistant that can summarize a research results.",
        model="gpt-4o",
    )
    return Agent(
        name="Researcher",
        instructions=(
            "You are a helpful assistant that can research a topic using your research tool. "
            "Always research the topic before summarizing."
        ),
        tools=[research],
        handoffs=[summarizer],
        model="gpt-4o",
    )


@input_guardrail
async def simple_input_guardrail(context, agent, inp):
    from agents import GuardrailFunctionOutput

    return GuardrailFunctionOutput(output_info="dummy", tripwire_triggered=False)


@output_guardrail
async def simple_output_guardrail(context, agent, inp):
    from agents import GuardrailFunctionOutput

    return GuardrailFunctionOutput(output_info="dummy", tripwire_triggered=False)


def guardrail_agent():
    return Agent(
        name="Simple Agent with Guardrails",
        instructions="You are a helpful assistant specialized in addition calculations.",
        input_guardrails=[simple_input_guardrail],
        output_guardrails=[simple_output_guardrail],
        tools=[add],
        model="gpt-4o",
    )
