'use strict'

const anthropic = require('./anthropic')
const openai = require('./openai')
const vercelAi = require('./vercel-ai')

let isEnabled = false

/**
 * Enables all AI Guard provider integrations.
 *
 * @param {object} aiguard
 * @param {boolean} block
 * @param {boolean} analyzeStreamResponses
 */
function enable (aiguard, block, analyzeStreamResponses) {
  if (isEnabled) return

  anthropic.enable(aiguard, block)
  openai.enable(aiguard, block)
  vercelAi.enable(aiguard, block, analyzeStreamResponses)

  isEnabled = true
}

function disable () {
  vercelAi.disable()
  openai.disable()
  anthropic.disable()
  isEnabled = false
}

module.exports = {
  enable,
  disable,
  anthropic,
  openai,
  vercelAi,
}
