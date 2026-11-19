'use strict'

const anthropic = require('./anthropic')
const openai = require('./openai')
const vercelAi = require('./vercel-ai')

let isEnabled = false

/**
 * Enables AI Guard provider integrations except those explicitly disabled.
 *
 * @param {object} aiguard
 * @param {boolean} block
 * @param {boolean} analyzeStreamResponses
 * @param {string[]} [disabledIntegrations]
 */
function enable (aiguard, block, analyzeStreamResponses, disabledIntegrations = []) {
  if (isEnabled) return

  if (!disabledIntegrations.includes('anthropic')) anthropic.enable(aiguard, block, analyzeStreamResponses)
  if (!disabledIntegrations.includes('openai')) openai.enable(aiguard, block, analyzeStreamResponses)
  if (!disabledIntegrations.includes('ai')) vercelAi.enable(aiguard, block, analyzeStreamResponses)

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
