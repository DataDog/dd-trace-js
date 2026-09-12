'use strict'

function unavailable () {
  return Promise.reject(new Error('Prompt Management requires tracer.init()'))
}

class NoopPrompts {
  /**
   * @param {string} promptId
   * @param {import('../../../../../index').llmobs.GetPromptOptions} [options]
   * @returns {Promise<import('../../../../../index').llmobs.ManagedPrompt>}
   */
  getPrompt (promptId, options) { return unavailable() }

  /**
   * @param {string} promptId
   * @returns {Promise<import('../../../../../index').llmobs.ManagedPrompt | undefined>}
   */
  refreshPrompt (promptId) { return unavailable() }

  /** @param {import('../../../../../index').llmobs.ClearPromptCacheOptions} [options] */
  clearPromptCache (options) {}

  /**
   * @param {string} promptId
   * @param {string | import('../../../../../index').llmobs.PromptTemplateMessage[]} template
   * @param {import('../../../../../index').llmobs.CreatePromptOptions} [options]
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse>}
   */
  createPrompt (promptId, template, options) { return unavailable() }

  /**
   * @param {string} promptId
   * @param {string | import('../../../../../index').llmobs.PromptTemplateMessage[]} template
   * @param {import('../../../../../index').llmobs.CreatePromptVersionOptions} [options]
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse>}
   */
  createPromptVersion (promptId, template, options) { return unavailable() }

  /**
   * @param {string} promptId
   * @param {import('../../../../../index').llmobs.UpdatePromptOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse>}
   */
  updatePrompt (promptId, options) { return unavailable() }

  /**
   * @param {string} promptId
   * @param {number} version
   * @param {import('../../../../../index').llmobs.UpdatePromptVersionOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse>}
   */
  updatePromptVersion (promptId, version, options) { return unavailable() }

  /**
   * @param {string} promptId
   * @returns {Promise<import('../../../../../index').llmobs.DeletedPromptResponse>}
   */
  deletePrompt (promptId) { return unavailable() }

  /** @returns {Promise<import('../../../../../index').llmobs.PromptResponse[]>} */
  listPrompts () { return unavailable() }

  /**
   * @param {string} promptId
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse[]>}
   */
  listPromptVersions (promptId) { return unavailable() }
}

module.exports = NoopPrompts
