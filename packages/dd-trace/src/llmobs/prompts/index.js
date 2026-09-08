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
   * @param {import('../../../../../index').llmobs.GetPromptOptions} options
   * @returns {Promise<ManagedPrompt>}
   */
  get (id, options) { return this.#manager.get(id, options) }

  /**
   * Create a prompt.
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  create (payload) { return this.#manager.create(payload) }

  /**
   * Create a prompt version.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  createVersion (id, payload) { return this.#manager.createVersion(id, payload) }

  /**
   * Update a prompt.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  update (id, payload) { return this.#manager.update(id, payload) }

  /**
   * Update a prompt version.
   * @param {string} id
   * @param {string | number} version
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  updateVersion (id, version, payload) { return this.#manager.updateVersion(id, version, payload) }

  /**
   * Delete a prompt.
   * @param {string} id
   * @returns {Promise<void>}
   */
  delete (id) { return this.#manager.delete(id) }

  /**
   * List prompts.
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown> | unknown[]>}
   */
  list (params = {}) { return this.#manager.list(params) }

  /**
   * List prompt versions.
   * @param {string} id
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown> | unknown[]>}
   */
  listVersions (id, params = {}) { return this.#manager.listVersions(id, params) }

  /**
   * Refresh a managed prompt.
   * @param {string} id
   * @param {{version?: string | number, label?: string}} options
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
    timeout: llmobs.promptsTimeout ?? 5000,
  })
  return new Prompts(new PromptManager({
    client,
    cacheTtl: llmobs.DD_LLMOBS_PROMPTS_CACHE_TTL ?? llmobs.promptsCacheTtl ?? 60,
    fileCacheEnabled: llmobs.promptsFileCacheEnabled ?? false,
    fileCacheDir: llmobs.promptsFileCacheDir ?? path.join(os.tmpdir(), 'dd-trace-js-llmobs-prompts'),
    env: config.env,
  }))
}

module.exports = { Prompts, createPrompts, ManagedPrompt, PromptAPIError }
