'use strict'

const skippedMcpToolCalls = new WeakMap()

/**
 * Records an MCP call owned by a LangChain MCP adapter tool.
 *
 * @param {object} span The active LangChain tool span.
 * @param {object} client The MCP client making the call.
 * @param {string} toolName The MCP tool name.
 * @returns {void}
 */
function skipMcpToolCall (span, client, toolName) {
  if (span && client && toolName) skippedMcpToolCalls.set(span, { client, toolName })
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
  const skippedCall = span && skippedMcpToolCalls.get(span)
  return skippedCall?.client === client && skippedCall.toolName === toolName
}

module.exports = { skipMcpToolCall, shouldSkipMcpToolCall }
