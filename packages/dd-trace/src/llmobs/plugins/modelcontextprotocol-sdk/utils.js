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

  const { _meta: _, ...rest } = params ?? {}
  if (hasEnvelopeKeys || hasRequestKeys) {
    params = { ...rest, _meta: meta }
  } else if (params) {
    params = rest
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

module.exports = { formatInput, formatOutput, formatServerInput, getClientInfoTags, safeStringify }
