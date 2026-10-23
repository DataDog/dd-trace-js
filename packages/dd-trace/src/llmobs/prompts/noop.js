'use strict'

function unavailable () {
  return Promise.reject(new Error('Prompt Management requires tracer.init()'))
}

class NoopPrompts {
  getPrompt (promptId, options) { return unavailable() }

  refreshPrompt (promptId) { return unavailable() }

  clearPromptCache (options) {}

  createPrompt (promptId, template, options) { return unavailable() }

  createPromptVersion (promptId, template, options) { return unavailable() }

  updatePrompt (promptId, options) { return unavailable() }

  updatePromptVersion (promptId, version, options) { return unavailable() }

  deletePrompt (promptId) { return unavailable() }

  listPrompts () { return unavailable() }

  listPromptVersions (promptId) { return unavailable() }
}

module.exports = NoopPrompts
