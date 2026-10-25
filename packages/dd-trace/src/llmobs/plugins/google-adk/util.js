'use strict'

const MODEL_PREFIXES = [
  ['text-embedding', 'google'],
  ['gemini', 'google'],
  ['imagen', 'google'],
  ['veo', 'google'],
  ['jamba', 'ai21'],
  ['claude', 'anthropic'],
  ['llama', 'meta'],
  ['mistral', 'mistral'],
  ['codestral', 'mistral'],
  ['deepseek', 'deepseek'],
  ['olmo', 'ai2'],
  ['tulu', 'ai2'],
  ['molmo', 'ai2'],
  ['specter', 'ai2'],
  ['cosmoo', 'ai2'],
  ['qodo', 'qodo'],
  ['mars', 'camb.ai'],
]

function extractModelInfo (model) {
  const rawModel = typeof model === 'string' ? model : model?.model
  const modelName = rawModel?.split('/').at(-1) || 'custom'
  const prefix = modelName.toLowerCase()
  const modelProvider = MODEL_PREFIXES.find(([name]) => prefix.startsWith(name))?.[1] || 'custom'

  return { modelName, modelProvider }
}

module.exports = { extractModelInfo }
