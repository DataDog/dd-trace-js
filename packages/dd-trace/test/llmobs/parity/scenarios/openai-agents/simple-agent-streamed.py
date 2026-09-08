import asyncio

from agents import Runner

from _agents_common import finish
from _agents_common import setup
from _agents_common import simple_agent


async def main():
    setup()
    result = Runner.run_streamed(simple_agent(), "What is the capital of France?")
    async for event in result.stream_events():
        del event
    finish()


asyncio.run(main())
