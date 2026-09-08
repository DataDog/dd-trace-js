'use strict'

const os = require('node:os')
const path = require('node:path')

const { getValueFromEnvSources } = require('../../config/helper')
const log = require('../../log')
const { PromptsClient } = require('./client')
const { PromptAPIError } = require('./errors')
const { PromptManager } = require('./manager')
const { NoopPrompts } = require('./noop')
const { ManagedPrompt } = require('./prompt')

class Prompts {
  #manager

  constructor (manager) {
    this.#manager = manager
  }

  /**
   * Retrieve a managed prompt.
   * @param {string} id
   * @param {import('../../../../../index').llmobs.GetPromptOptions} [options]
   * @returns {Promise<ManagedPrompt>}
   */
  get (id, options) { return this.#manager.get(id, options) }

  /**
   * Create a prompt.
   * @param {import('../../../../../index').llmobs.PromptCreateOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse>}
   */
  create (options) { return this.#manager.create(options) }

  /**
   * Create a prompt version.
   * @param {string} id
   * @param {import('../../../../../index').llmobs.PromptVersionCreateOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse>}
   */
  createVersion (id, options) { return this.#manager.createVersion(id, options) }

  /**
   * Update a prompt.
   * @param {string} id
   * @param {import('../../../../../index').llmobs.PromptUpdateOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse>}
   */
  update (id, options) { return this.#manager.update(id, options) }

  /**
   * Update a prompt version.
   * @param {string} id
   * @param {string | number} version
   * @param {import('../../../../../index').llmobs.PromptVersionUpdateOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse>}
   */
  updateVersion (id, version, options) { return this.#manager.updateVersion(id, version, options) }

  /**
   * Delete a prompt.
   * @param {string} id
   * @returns {Promise<import('../../../../../index').llmobs.DeletedPromptResponse>}
   */
  delete (id) { return this.#manager.delete(id) }

  /**
   * List prompts.
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse[]>}
   */
  list () { return this.#manager.list() }

  /**
   * List prompt versions.
   * @param {string} id
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse[]>}
   */
  listVersions (id) { return this.#manager.listVersions(id) }

  /**
   * Refresh a managed prompt.
   * @param {string} id
   * @param {{version?: string | number, label?: string}} [options]
   * @returns {Promise<ManagedPrompt>}
   */
  refresh (id, options) { return this.#manager.refresh(id, options) }

  /**
   * Clear prompt caches.
   * @returns {void}
   */
  clearCache () { return this.#manager.clearCache() }
}

function createPrompts (config) {
  if (!config.llmobs?.DD_LLMOBS_ENABLED) return new NoopPrompts({ reason: 'LLM Observability is not enabled' })
  if (!config.DD_API_KEY) {
    log.warn('LLMObs prompts: missing api key, set DD_API_KEY')
    return new NoopPrompts({ reason: 'DD_API_KEY is required for prompt management' })
  }

  const llmobs = config.llmobs
  const overrideOrigin = config.DD_LLMOBS_OVERRIDE_ORIGIN ??
    getValueFromEnvSources('DD_LLMOBS_OVERRIDE_ORIGIN')
  const client = new PromptsClient({
    apiKey: config.DD_API_KEY,
    appKey: config.DD_APP_KEY,
    site: config.site,
    overrideOrigin,
    timeout: (llmobs.promptsTimeout ?? 5) * 1000,
  })
  return new Prompts(new PromptManager({
    client,
    cacheTtl: llmobs.promptsCacheTtl ?? 60,
    fileCacheEnabled: llmobs.promptsFileCacheEnabled ?? false,
    fileCacheDir: llmobs.promptsFileCacheDir ?? path.join(os.tmpdir(), 'dd-trace-js-llmobs-prompts'),
    env: config.env,
  }))
}

module.exports = { Prompts, createPrompts, ManagedPrompt, PromptAPIError }
