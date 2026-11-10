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
// Client identity is self-reported and repeated on every tool call span in a session
const MAX_CLIENT_INFO_TAG_LENGTH = 256

/**
 * Formats a server request as JSON, without the trace context and the SDK's reserved `_meta` keys. Stateless requests
 * repeat the client's identity and capabilities under those keys on every call.
 *
 * @param {{ id?: unknown, method?: string, params?: Record<string, unknown> }} request
 */
function formatServerInput (request) {
  let params = request.params
  const meta = params?._meta
  if (meta && typeof meta === 'object') {
    const keptMeta = {}
    let hasKeptMeta = false
    for (const [key, value] of Object.entries(meta)) {
      if (key === DISTRIBUTED_TRACE_META_KEY || key.startsWith(RESERVED_META_KEY_PREFIX)) continue
      keptMeta[key] = value
      hasKeptMeta = true
    }
    const { _meta: _, ...rest } = params
    params = hasKeptMeta ? { ...rest, _meta: keptMeta } : rest
  }

  try {
    return JSON.stringify({ method: request.method, params, jsonrpc: '2.0', id: request.id })
  } catch {
    return ''
  }
}

/**
 * @param {{ params?: { _meta?: Record<string, unknown> } }} request
 * @param {{ getClientVersion?: () => unknown } | undefined} server
 */
function getClientInfoTags (request, server) {
  const clientInfo = request.params?._meta?.[CLIENT_INFO_META_KEY] ?? server?.getClientVersion?.()
  const tags = {}
  if (!clientInfo || typeof clientInfo !== 'object') return tags

  for (const field of ['name', 'title', 'version']) {
    const value = clientInfo[field]
    if (value) tags[`mcp_client_${field}`] = String(value).slice(0, MAX_CLIENT_INFO_TAG_LENGTH)
  }
  return tags
}

module.exports = { formatInput, formatOutput, formatServerInput, getClientInfoTags }
