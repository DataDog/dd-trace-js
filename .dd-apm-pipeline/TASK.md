# Fix duplicate LangChain/MCP LLM Observability tool payloads

## Reported Environment

- `dd-trace` 6.3.0
- Node.js 22.22.3
- `@langchain/mcp-adapters` 1.1.3
- `@langchain/core` 1.1.48
- `@modelcontextprotocol/sdk` 1.29.0
- `DD_LLMOBS_ENABLED=1`

This is the full offline issue report. Do not depend on GitHub access.

## Actual Behavior

When LangChain MCP adapters call an MCP tool, both `langchain` and `modelcontextprotocol-sdk` LLMObs integrations
capture it. One logical call produces nested payload-bearing tool spans:

```text
tool: mcp__myserver__my_tool                 (LangChain StructuredTool.invoke)
tool: MCP Client Tool Call: my_tool          (MCP Client.callTool)
```

Both retain equivalent input/output. `Client.listTools()` also emits `task: MCP Client List Tools` with the full
serialized tool list. A common per-request `MultiServerMCPClient` setup repeats static schema JSON on every
request. In the report, a 26 KB tool result consumed about 105 KB across nested spans. This is storage/trace-view
noise and double-counts tool errors; it is not an LLMObs billing defect.

## Expected Behavior

One logical MCP tool call should yield one LLMObs tool span with one payload, mirroring the existing
LangChain/Anthropic LLM-span dedup behavior. MCP list-tools payload capture must not repeatedly ingest static tool
schemas. A supported opt-out is also acceptable if it keeps ordinary APM spans and distributed trace propagation.

## Existing Workaround and Constraint

This currently suppresses MCP LLMObs capture but retains APM spans and the critical
`params._meta._dd_trace_context` injection used to parent out-of-process MCP server spans:

```js
tracer.use('modelcontextprotocol-sdk', {
  llmobs_mcp_tool_call: false,
  llmobs_mcp_list_tools: false,
})
```

The sub-plugin IDs are undocumented internal keys and absent from TypeScript types. Do not break the preserved APM
and propagation behavior while implementing a supported configuration or default deduplication.

## Self-Contained Reproduction

Run with:

```sh
DD_LLMOBS_ENABLED=1 DD_LLMOBS_ML_APP=repro DD_TRACE_AGENT_URL=http://127.0.0.1:1 \
DD_TELEMETRY_ENABLED=false node --import dd-trace/initialize.mjs repro.mjs
```

```js
import { createRequire } from 'node:module'
import * as dc from 'node:diagnostics_channel'

const require = createRequire(import.meta.url)
const LLMObsTagger = require('dd-trace/packages/dd-trace/src/llmobs/tagger.js')
dc.channel('dd-trace:span:finish').subscribe((span) => {
  const tags = LLMObsTagger.tagMap.get(span)
  if (tags) console.log(`${tags['_ml_obs.meta.span.kind']}: ${tags['_ml_obs.name'] ?? span._name}`)
})

const adapterRequire = createRequire(import.meta.resolve('@langchain/mcp-adapters'))
const { McpServer } = adapterRequire('@modelcontextprotocol/sdk/server/mcp.js')
const { Client } = adapterRequire('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = adapterRequire('@modelcontextprotocol/sdk/inMemory.js')
const { loadMcpTools } = await import('@langchain/mcp-adapters')
const { z } = await import('zod')

const server = new McpServer({ name: 'repro-mcp', version: '0.0.0' })
server.tool('echo_tool', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}` }],
}))
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
const client = new Client({ name: 'repro-client', version: '0.0.0' })
await client.connect(clientTransport)

const [echoTool] = await loadMcpTools('repro', client, {
  prefixToolNameWithServerName: true,
  additionalToolNamePrefix: 'mcp',
})
await echoTool.invoke({ name: echoTool.name, args: { text: 'hi' }, id: 'call_1', type: 'tool_call' })
await new Promise(resolve => setTimeout(resolve, 300))
await client.close()
await server.close()
```

Baseline output:

```text
task: MCP Client List Tools
tool: MCP Client Tool Call: echo_tool
tool: mcp__repro__echo_tool
```

## Relevant Current Code

- `packages/datadog-plugin-modelcontextprotocol-sdk/src/tracing.js` declares client `callTool` and `listTools`
  sub-plugins.
- `packages/datadog-plugin-modelcontextprotocol-sdk/src/index.js` composes tracing and LLMObs sub-plugins.
- `packages/datadog-plugin-langchain/src/tracing.js` has `ToolInvokePlugin` for `@langchain/core:Tool_invoke`.
- Existing MCP tests include `packages/datadog-plugin-modelcontextprotocol-sdk/test/index.spec.js`; LangChain tests
  are under `packages/datadog-plugin-langchain/test/index.spec.js`.
- Related LLM-span precedent: issue `#8936`; inspect its implementation/history for the actual dedup policy rather
  than inferring it from the report.

## Investigation and Scope

1. Delegate focused subagents to inspect the LangChain/MCP LLMObs lifecycle, the Anthropic/LangChain precedent,
   and composite-plugin configuration/types. The main agent must coordinate and reject unsupported conclusions.
2. Classify the report: a mechanical duplicate-span bug, intentional layering with missing public opt-out, or both.
3. Reproduce before editing. Capture names, kinds, parents, input/output fields, errors, and propagation metadata.
4. If default dedup is chosen, prove it only suppresses the nested equivalent tool span and preserves independent MCP
   calls. If config exposure is chosen, add documented typed configuration and prove it retains APM/propagation.
5. Treat `Client.listTools` separately: decide whether its output should be omitted, deduplicated, or configurable;
   do not silently remove legitimate dynamic tool discovery without evidence.
6. Keep changes narrow to the LangChain/MCP LLMObs and configuration/test surface. No broad LLMObs refactor.

## Acceptance Gates

1. Baseline reproduction records the current three LLMObs spans and payload duplication.
2. Fixed reproduction emits exactly one payload-bearing tool span for `echo_tool`; tests cover both integrations
   enabled together and each integration independently.
3. List-tools behavior is explicitly tested for the selected policy and large/static schemas are not repeatedly
   captured contrary to that policy.
4. APM MCP client spans and `_dd_trace_context` propagation remain present when LLMObs tool/list capture is disabled
   or deduplicated.
5. Run focused tests, final build, final lint, final review, and final observability capture on one unchanged
   revision. No PR is opened with missing evidence or unresolved policy ambiguity.
