'use strict'

const openai = require('./openai')
const vercelAi = require('./vercel-ai')

let isEnabled = false

/**
 * Enables all AI Guard provider integrations.
 *
 * @param {object} aiguard
 * @param {boolean} block
 */
function enable (aiguard, block) {
  if (isEnabled) return

  openai.enable(aiguard, block)
  vercelAi.enable(aiguard, block)

  isEnabled = true
}

function disable () {
  vercelAi.disable()
  openai.disable()
  isEnabled = false
}

module.exports = {
  enable,
  disable,
  openai,
  vercelAi,
}
