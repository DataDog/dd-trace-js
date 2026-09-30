import asyncio

from common import finish
from common import start


async def main():
    start("mcp")

    from mcp.server.fastmcp import FastMCP
    from mcp.shared.memory import create_connected_server_and_client_session

    server = FastMCP("TestServer")

    @server.tool(description="This tool always raises an exception.")
    def failing_tool(param: str) -> str:
        raise ValueError("Tool execution failed")

    async with create_connected_server_and_client_session(server._mcp_server) as session:
        await session.initialize()
        await session.call_tool("failing_tool", {"param": "value"})
    finish()


asyncio.run(main())
