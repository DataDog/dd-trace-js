import asyncio

from agents import Runner

from _agents_common import finish
from _agents_common import research_workflow
from _agents_common import setup


async def main():
    setup()
    await Runner.run(
        research_workflow(),
        "What is a brief summary of what happened yesterday in the soccer world??",
    )
    finish()


asyncio.run(main())
