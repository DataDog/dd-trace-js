import asyncio

from agents import Runner

from _agents_common import finish
from _agents_common import guardrail_agent
from _agents_common import setup


async def main():
    setup(chat_api=True)
    await Runner.run(guardrail_agent(), "What is the sum of 1 and 2?")
    finish()


asyncio.run(main())
