'use strict'

// Run with --expose-gc. It fails with a message when the AI Guard MCP records keep a client alive.
const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { createClientServer, linkMcpTools, recordListedTools } = require('../../../src/aiguard/mcp')

/**
 * Lists a tool for a client, links a model request to it, and marks an allowed model tool call.
 * The application keeps the schema and the trace, and drops the client.
 *
 * @param {{ type: string }} schema
 * @param {{ started: object[] }} trace
 */
function useClient (schema, trace) {
  const client = { name: 'closed client', buffer: Buffer.alloc(1024) }
  const server = createClientServer({ type: 'streamable_http', url: 'https://mcp.example.com/mcp' })
  recordListedTools(client, server, [{ name: 'search', inputSchema: schema }])

  const root = { context: () => ({ _trace: trace }) }
  const requestSpan = { context: () => ({ _trace: trace }) }
  trace.started.push(root, requestSpan)
  const link = linkMcpTools(
    [{ type: 'function', function: { name: 'search', parameters: schema } }],
    tool => tool.function,
    { tracingContext: { currentStore: { span: requestSpan } } }
  )
  assert.ok(link, 'the request must link to the listed tool')

  const outputs = link.attach([{
    role: 'assistant',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
  }], () => true)
  const evaluation = link.evaluation(outputs, outputs)
  assert.ok(evaluation?.onAllowed, 'the allowed output must get a mark')
  evaluation.onAllowed()

  return new WeakRef(client)
}

async function main () {
  const schema = { type: 'object' }
  const trace = { started: [] }
  const client = useClient(schema, trace)

  // Leave the job that created the WeakRef before the garbage collection.
  await setImmediate()
  assert.ok(global.gc, 'run the fixture with --expose-gc')
  global.gc()

  assert.strictEqual(client.deref(), undefined, 'the schema record and the mark must not keep the client')
  assert.ok(schema && trace)
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
