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
const RESERVED_META_KEY_PREFIX = 'io.modelcontextprotocol/'
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
 * Formats a server request as JSON-RPC without the trace context and the SDK's reserved `_meta` keys, which stateless
 * requests repeat on every call.
 * @param {{ method?: string, id?: string|number, params?: { _meta?: Record<string, unknown> } }} [request]
 * @param {string|number} [requestId] SDK 2.x handlers receive the request without its JSON-RPC id.
 */
function formatServerInput (request, requestId) {
  let params = request?.params
  const meta = params?._meta
  if (meta && typeof meta === 'object') {
    const { _meta: _, ...rest } = params
    const keptMeta = {}
    let hasKeptMeta = false
    for (const [key, value] of Object.entries(meta)) {
      if (key === DISTRIBUTED_TRACE_META_KEY || key.startsWith(RESERVED_META_KEY_PREFIX)) continue
      keptMeta[key] = value
      hasKeptMeta = true
    }
    params = hasKeptMeta ? { ...rest, _meta: keptMeta } : rest
  }

  return safeStringify({ method: request?.method, params, jsonrpc: '2.0', id: request?.id ?? requestId })
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
