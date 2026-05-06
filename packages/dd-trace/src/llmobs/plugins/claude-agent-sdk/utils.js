'use strict'

const SOURCE_TO_TRIGGER = {
  startup: 'fresh',
  resume: 'resume',
  clear: 'context_clear',
  compact: 'compaction',
}

function safeStringify (value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return '[unserializable]' }
}

function splitModel (model) {
  if (!model) return { modelName: undefined, modelProvider: 'anthropic' }
  const idx = model.indexOf('/')
  if (idx === -1) return { modelName: model, modelProvider: 'anthropic' }
  return { modelName: model.slice(idx + 1), modelProvider: model.slice(0, idx) }
}

module.exports = { SOURCE_TO_TRIGGER, safeStringify, splitModel }
