'use strict'

const anthropic = require('./anthropic')
const mcp = require('./mcp')
const openai = require('./openai')
const vercelAi = require('./vercel-ai')

let isEnabled = false

/**
 * Enables all AI Guard provider integrations.
 *
 * @param {object} aiguard
 * @param {boolean} block
 * @param {boolean} analyzeStreamResponses
 * @param {boolean} [mcpEnabled] Whether to check MCP tool calls and to link them to model requests.
 */
function enable (aiguard, block, analyzeStreamResponses, mcpEnabled) {
  if (isEnabled) return

  anthropic.enable(aiguard, block, analyzeStreamResponses)
  openai.enable(aiguard, block, analyzeStreamResponses, mcpEnabled)
  vercelAi.enable(aiguard, block, analyzeStreamResponses)
  if (mcpEnabled) mcp.enable(aiguard, block)

  isEnabled = true
}

function disable () {
  mcp.disable()
  vercelAi.disable()
  openai.disable()
  anthropic.disable()
  isEnabled = false
}

module.exports = {
  enable,
  disable,
  anthropic,
  mcp,
  openai,
  vercelAi,
}
