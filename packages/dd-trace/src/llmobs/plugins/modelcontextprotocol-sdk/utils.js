'use strict'

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'

/**
 * @param {object} toolArguments - The arguments passed to the tool
 * @returns {string} Formatted input string
 */
function formatToolInput (toolArguments) {
  try {
    return JSON.stringify(toolArguments ?? {})
  } catch {
    return ''
  }
}

/**
 * Formats MCP tool call result as a structured object matching Python's output format.
 * MCP tool results contain a `content` array with items like:
 * `[{ type: 'text', text: '...' }, { type: 'image', data: '...', mimeType: '...' }]`
 * @param {object} result - The MCP CallToolResult
 * @returns {string} JSON string of `{ content: Array<{type, text, annotations, meta}>, isError: boolean }`
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

/**
 * @param {object} params - MCP tool request params.
 * @returns {string} The tool name, or `unknown_tool` if not found.
 */
function getRequestToolName (params) {
  return params?.name || 'unknown_tool'
}

function safeStringify (value) {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function formatServerRequestOutput (result) {
  return safeStringify(result)
}

function getInitializeClientInfo (request) {
  const clientInfo = request?.params?.clientInfo
  if (!clientInfo || typeof clientInfo !== 'object') return {}

  const name = clientInfo.name
  const version = clientInfo.version

  return {
    name: typeof name === 'string' ? name : undefined,
    version: typeof version === 'string' ? version : undefined,
  }
}

function sanitizeRequestParams (params) {
  if (!params || typeof params !== 'object') return params

  const meta = params._meta
  if (!meta || meta[DISTRIBUTED_TRACE_META_KEY] === undefined) return params

  const input = {}
  let hasInput = false

  for (const key of Object.keys(params)) {
    if (key === '_meta') continue

    input[key] = params[key]
    hasInput = true
  }

  const sanitizedMeta = {}
  let hasMeta = false

  for (const key of Object.keys(meta)) {
    if (key === DISTRIBUTED_TRACE_META_KEY) continue

    sanitizedMeta[key] = meta[key]
    hasMeta = true
  }

  if (hasMeta) {
    input._meta = sanitizedMeta
    hasInput = true
  }

  return hasInput ? input : undefined
}

/**
 * Formats an MCP server request without internal trace propagation metadata.
 * @param {object} request - The MCP JSON-RPC request
 * @returns {string|null} JSON string of the sanitized request, or null if nothing remains
 */
function formatServerRequestInput (request) {
  if (!request) return null

  const sanitizedRequest = {}
  let hasInput = false

  for (const key of Object.keys(request)) {
    if (key === 'params') {
      const params = sanitizeRequestParams(request.params)
      if (params === undefined) continue

      sanitizedRequest.params = params
    } else {
      sanitizedRequest[key] = request[key]
    }

    hasInput = true
  }

  return hasInput ? safeStringify(sanitizedRequest) : null
}

module.exports = {
  formatOutput,
  formatServerRequestInput,
  formatServerRequestOutput,
  formatToolInput,
  getInitializeClientInfo,
  getRequestToolName,
}
