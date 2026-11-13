import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The ESM build of the SDK, with one allowed call and one call that AI Guard blocks. MCP_SDK=v2
// selects the ESM build of the MCP v2 client.
const { Client, StdioClientTransport } = process.env.MCP_SDK === 'v2'
  ? { ...await import('@modelcontextprotocol/client'), ...await import('@modelcontextprotocol/client/stdio') }
  : {
      ...await import('@modelcontextprotocol/sdk/client/index.js'),
      ...await import('@modelcontextprotocol/sdk/client/stdio.js'),
    }

const dirname = path.dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(dirname, 'mcp-stdio-server.js')],
  env: { MCP_SIDE_EFFECT_FILE: process.env.MCP_SIDE_EFFECT_FILE },
})
const client = new Client({ name: 'esm-client', version: '1.0.0' })
await client.connect(transport)

const outcomes = []
for (const text of ['esm allowed', 'esm [deny]']) {
  try {
    await client.callTool({ name: 'write_file', arguments: { text } })
    outcomes.push('allowed')
  } catch (error) {
    outcomes.push(error.name)
  }
}

await client.close()
// eslint-disable-next-line no-console
console.log(`OUTCOMES ${JSON.stringify(outcomes)}`)
