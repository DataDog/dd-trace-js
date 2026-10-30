import asyncio

from common import finish
from common import start


async def main():
    start("mcp")

    from mcp.server.fastmcp import FastMCP
    from mcp.shared.memory import create_connected_server_and_client_session

    server = FastMCP("TestServer")

    @server.tool(description="Perform arithmetic operations.")
    def calculator(operation: str, a: int, b: int) -> dict:
        if operation == "add":
            return {"result": a + b}
        return {"result": 42}

    async with create_connected_server_and_client_session(server._mcp_server) as session:
        await session.initialize()
        await session.list_tools()
        await session.call_tool("calculator", {"operation": "add", "a": 20, "b": 22})
    finish()


asyncio.run(main())
