'use strict'

const mcpToolCalls = new WeakMap()
const mcpListToolsCaptures = new WeakMap()

/**
 * Records an MCP call owned by a LangChain MCP adapter tool.
 *
 * @param {object} span The active LangChain tool span.
 * @param {object} client The MCP client making the call.
 * @param {string} toolName The MCP tool name.
 * @returns {void}
 */
function skipMcpToolCall (span, client, toolName) {
  if (span && client && toolName) mcpToolCalls.set(span, { client, toolName })
}

/**
 * Determines whether the MCP call is already represented by its owning LangChain adapter tool span.
 *
 * @param {object} span The active LangChain tool span.
 * @param {object} client The MCP client making the call.
 * @param {string | undefined} toolName The MCP tool name.
 * @returns {boolean} Whether LLMObs span creation should be skipped.
 */
function shouldSkipMcpToolCall (span, client, toolName) {
  const skippedCall = span && mcpToolCalls.get(span)
  return skippedCall?.client === client && skippedCall.toolName === toolName
}

/**
 * Associates an MCP list-tools span with its capture state.
 *
 * @param {object} span The MCP list-tools span.
 * @param {{ state: { submitted: boolean }, captured: boolean }} capture The capture state.
 * @returns {void}
 */
function registerMcpListToolsCapture (span, capture) {
  mcpListToolsCaptures.set(span, capture)
}

/**
 * Gets the capture state for an MCP list-tools span.
 *
 * @param {object} span The MCP list-tools span.
 * @returns {{ state: { submitted: boolean }, captured: boolean } | undefined} The capture state.
 */
function getMcpListToolsCapture (span) {
  return mcpListToolsCaptures.get(span)
}

module.exports = {
  getMcpListToolsCapture,
  registerMcpListToolsCapture,
  shouldSkipMcpToolCall,
  skipMcpToolCall,
}
