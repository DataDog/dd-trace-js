import asyncio

from _agents_common import finish
from _agents_common import setup
from _agents_common import simple_agent


async def main():
    setup()
    await Runner.run(simple_agent(), "What is the capital of France?")
    finish()


from agents import Runner

asyncio.run(main())
