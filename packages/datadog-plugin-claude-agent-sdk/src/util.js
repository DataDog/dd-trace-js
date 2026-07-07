'use strict'

/**
 * Parse a model ID string into the model name and provider for claude agent sdk provided model IDs
 * @param {string} model model id
 * @returns {{ modelName: string, modelProvider: string }}
 */
function splitModel (model) {
  if (!model) return { modelName: undefined, modelProvider: 'anthropic' }
  const idx = model.indexOf('/')
  if (idx === -1) return { modelName: model, modelProvider: 'anthropic' }
  return { modelName: model.slice(idx + 1), modelProvider: model.slice(0, idx) }
}

module.exports = { splitModel }
