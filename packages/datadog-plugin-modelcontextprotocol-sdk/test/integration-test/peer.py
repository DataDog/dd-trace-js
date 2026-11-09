import asyncio
import json
import os
import sys

from ddtrace import patch, tracer

patch(mcp=True)

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.fastmcp import FastMCP


def serve():
    server = FastMCP("python-peer")

    @server.tool()
    def trace_context() -> str:
        span = tracer.current_root_span()
        return json.dumps({
            "trace_id": format(span.trace_id, "032x"),
            "parent_id": str(span.parent_id or 0),
        })

    server.run(transport="stdio")


async def call():
    params = StdioServerParameters(
        command=sys.argv[2],
        args=sys.argv[3:],
        env=dict(os.environ),
    )
    with tracer.trace("python.parent") as parent:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                result = await client.call_tool("trace-context", arguments={})
                if result.isError:
                    raise RuntimeError(result.content[0].text)
                response = json.loads(result.content[0].text)
        print(json.dumps({"trace_id": format(parent.trace_id, "032x"), "response": response}))


if sys.argv[1] == "server":
    serve()
else:
    asyncio.run(call())
