import asyncio

from agents import Runner

from _agents_common import addition_agent_with_tool_errors
from _agents_common import finish
from _agents_common import setup


async def main():
    setup()
    await Runner.run(addition_agent_with_tool_errors(), "What is the sum of 1 and 2?")
    finish()


asyncio.run(main())
