'use strict'

/**
 * Formats tool call input as a JSON string.
 * @param {string} toolName - The name of the tool being called
 * @param {object} toolArguments - The arguments passed to the tool
 */
function formatInput (toolName, toolArguments) {
  if (!toolName && !toolArguments) return ''

  if (toolArguments === undefined || toolArguments === null) {
    return toolName || ''
  }

  try {
    return JSON.stringify({ name: toolName, arguments: toolArguments })
  } catch {
    return toolName || ''
  }
}

/**
 * Formats MCP tool call result as a structured object matching Python's output format.
 * MCP tool results contain a `content` array with items like:
 * `[{ type: 'text', text: '...' }, { type: 'image', data: '...', mimeType: '...' }]`
 * @param {object} result - The MCP CallToolResult
 */
function formatOutput (result) {
  if (!result) return ''

  const content = result.content
  const isError = result.isError || false

  const processed = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type !== 'text') continue
      const contentBlock = {
        type: item.type,
        text: item.text || '',
        annotations: item.annotations || {},
        meta: item._meta || {},
      }
      processed.push(contentBlock)
    }
  }

  try {
    return JSON.stringify({ content: processed, isError })
  } catch {
    return ''
  }
}

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo'
const MAX_CLIENT_INFO_TAG_LENGTH = 256

/**
 * @param {unknown} value
 */
function safeStringify (value) {
  if (value === undefined) return
  try {
    return JSON.stringify(value)
  } catch {}
}

/**
 * Copies `_meta` keys except the trace context.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} [source]
 */
function copyMetaKeys (target, source) {
  if (!source) return false

  let copied = false
  for (const key of Object.keys(source)) {
    if (key === DISTRIBUTED_TRACE_META_KEY) continue
    target[key] = source[key]
    copied = true
  }
  return copied
}

/**
 * Formats a server request as JSON-RPC without the trace context. Before a handler runs, SDK 2.x moves the reserved
 * `io.modelcontextprotocol/*` `_meta` keys into `mcpReq.envelope` and drops the JSON-RPC id. Both are put back, so the
 * input matches the request that the client sent.
 * @param {{ method?: string, id?: string|number, params?: { _meta?: Record<string, unknown> } }} [request]
 * @param {{ id?: string|number, envelope?: Record<string, unknown> }} [mcpReq]
 */
function formatServerInput (request, mcpReq) {
  let params = request?.params
  const meta = {}
  const hasEnvelopeKeys = copyMetaKeys(meta, mcpReq?.envelope)
  const hasRequestKeys = copyMetaKeys(meta, params?._meta)

  const rest = {}
  let hasRest = false
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (key === '_meta') continue
      rest[key] = value
      hasRest = true
    }
  }
  if (hasEnvelopeKeys || hasRequestKeys) {
    params = { ...rest, _meta: meta }
  } else if (params?._meta !== undefined) {
    // `_meta` held only the trace context that the client tracer added, so drop `params` if nothing else is left.
    params = hasRest ? rest : undefined
  }

  return safeStringify({ method: request?.method, params, jsonrpc: '2.0', id: request?.id ?? mcpReq?.id })
}

/**
 * Client identity comes from the request envelope on stateless requests and from the handshake otherwise.
 * @param {Record<string, unknown>} [envelope]
 * @param {{ getClientVersion?: () => unknown }} [server]
 */
function getClientInfoTags (envelope, server) {
  const clientInfo = envelope?.[CLIENT_INFO_META_KEY] ?? server?.getClientVersion?.()
  const tags = {}
  if (!clientInfo || typeof clientInfo !== 'object') return tags

  for (const field of ['name', 'title', 'version']) {
    const value = clientInfo[field]
    if (value) tags[`mcp_client_${field}`] = String(value).slice(0, MAX_CLIENT_INFO_TAG_LENGTH)
  }
  return tags
}

const TELEMETRY_KEY = 'telemetry'
const INTENT_KEY = 'intent'
const CONVERSATION_ID_KEY = 'conversation_id'
// The client writes these values, so a cap keeps the span event under the intake size limit.
const MAX_INTENT_LENGTH = 1024
const MAX_CONVERSATION_ID_LENGTH = 256
const INTENT_PROPERTY = {
  type: 'string',
  description: 'Briefly describe the wider context task, and why this tool was chosen. Omit argument values, ' +
    'PII/secrets. Use English.',
}
const CONVERSATION_ID_PROPERTY = {
  type: 'string',
  description: 'Required on every call after your first call to this server: the conversation_id from an earlier ' +
    'result of this server. Omit only this field on your first call.',
}

/**
 * @typedef {{ intent?: boolean, session?: boolean }} TelemetryOptions
 */

/**
 * @param {TelemetryOptions} options
 */
function getTelemetrySchema ({ intent, session }) {
  const properties = {}
  if (intent) properties[INTENT_KEY] = INTENT_PROPERTY
  if (session) properties[CONVERSATION_ID_KEY] = CONVERSATION_ID_PROPERTY
  return { type: 'object', properties, required: intent ? [INTENT_KEY] : [], additionalProperties: false }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * UI-only tools cannot be called by the model, so they get no telemetry parameter.
 *
 * @param {{ _meta?: { ui?: { visibility?: unknown } } }} tool
 */
function isModelCallable (tool) {
  const visibility = tool._meta?.ui?.visibility
  return !Array.isArray(visibility) || visibility.includes('model')
}

/**
 * Returns a copy of a tools/list result where each model-callable tool gets a `telemetry` argument: a required intent
 * with intent capture, and an optional conversation ID with session capture. The SDK's own tool objects are not
 * changed, because it validates calls against them.
 *
 * @param {{ tools?: unknown }} result
 * @param {TelemetryOptions} options
 */
function injectTelemetrySchema (result, options) {
  if (!isObject(result) || !Array.isArray(result.tools)) return result

  const telemetrySchema = getTelemetrySchema(options)

  const tools = result.tools.map(tool => {
    if (!isObject(tool) || !isModelCallable(tool)) return tool

    const inputSchema = isObject(tool.inputSchema) ? tool.inputSchema : {}
    const properties = isObject(inputSchema.properties) ? inputSchema.properties : {}
    if (Object.hasOwn(properties, TELEMETRY_KEY)) return tool
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : []
    return {
      ...tool,
      inputSchema: {
        type: 'object',
        ...inputSchema,
        properties: { ...properties, [TELEMETRY_KEY]: telemetrySchema },
        required: !options.intent || required.includes(TELEMETRY_KEY) ? required : [...required, TELEMETRY_KEY],
      },
    }
  })
  return { ...result, tools }
}

/**
 * Any other value is the tool's own `telemetry` argument, which must reach the tool unchanged.
 *
 * @param {unknown} telemetry
 * @returns {telemetry is { intent?: unknown, conversation_id?: unknown } | null}
 */
function isInjectedTelemetry (telemetry) {
  if (telemetry === null) return true
  if (!isObject(telemetry)) return false
  for (const key of Object.keys(telemetry)) {
    if (key !== INTENT_KEY && key !== CONVERSATION_ID_KEY) return false
  }
  return true
}

/**
 * Returns a copy of a tools/call request without the `telemetry` argument, and the values it carried, or `undefined`
 * when the request has no `telemetry` argument of the injected shape. Other values belong to the tool.
 *
 * @param {{ params?: { arguments?: unknown } }} request
 * @returns {{ request: object, intent?: string, conversationId?: string } | undefined}
 */
function stripTelemetry (request) {
  const args = request?.params?.arguments
  if (!isObject(args) || !Object.hasOwn(args, TELEMETRY_KEY) || !isInjectedTelemetry(args[TELEMETRY_KEY])) return

  const { [TELEMETRY_KEY]: telemetry, ...rest } = args
  return {
    request: { ...request, params: { ...request.params, arguments: rest } },
    intent: capString(telemetry?.intent, MAX_INTENT_LENGTH),
    conversationId: capString(telemetry?.conversation_id, MAX_CONVERSATION_ID_LENGTH),
  }
}

/**
 * @param {unknown} value
 * @param {number} maxLength
 */
function capString (value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) || undefined : undefined
}

/**
 * Returns a copy of a tools/call result with one more text block that asks the agent to send the conversation ID on
 * later calls.
 *
 * @param {unknown} result
 * @param {string} conversationId
 */
function addConversationIdInstruction (result, conversationId) {
  if (!isObject(result) || !Array.isArray(result.content)) return result
  // The instruction would otherwise become the error message of an error result without text
  if (result.isError && !result.content.some(item => item?.type === 'text' && item.text)) return result

  const text = `Your conversation_id for this server is "${conversationId}". Add "telemetry": ` +
    `{"conversation_id": "${conversationId}"} to the arguments of every later tool call to this server, including ` +
    'calls you make in parallel.'
  return { ...result, content: [...result.content, { type: 'text', text }] }
}

module.exports = {
  addConversationIdInstruction,
  formatInput,
  formatOutput,
  formatServerInput,
  getClientInfoTags,
  injectTelemetrySchema,
  safeStringify,
  stripTelemetry,
}
