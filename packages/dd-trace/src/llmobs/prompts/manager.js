'use strict'

const log = require('../../log')
const { HotCache, WarmCache } = require('./cache')
const { ManagedPrompt } = require('./prompt')
const { cacheKey } = require('./util')

class PromptManager {
  #client
  #env
  #cacheTtl
  #hotCache
  #warmCache
  #inFlight = new Map()
  #warnedFallback = false

  /**
   * @param {{client?: object, cacheTtl?: number, fileCacheEnabled?: boolean,
   * fileCacheDir?: string, env?: string}} options
   */
  constructor ({ client, cacheTtl = 60, fileCacheEnabled = false, fileCacheDir, env } = {}) {
    this.#client = client
    this.#env = env
    this.#cacheTtl = cacheTtl
    this.#hotCache = new HotCache({ ttl: cacheTtl })
    this.#warmCache = new WarmCache({ dir: fileCacheEnabled ? fileCacheDir : undefined, ttl: cacheTtl })
  }

  /**
   * Retrieve a managed prompt.
   * @param {string} id
   * @param {import('../../../../../index').llmobs.GetPromptOptions} options
   * @returns {Promise<ManagedPrompt>}
   */
  get (id, options = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      return Promise.reject(new TypeError('Prompt id must be a non-empty string'))
    }
    const {
      version,
      label,
      env = this.#env,
      targetingKey,
      attributes,
      fallback,
      cacheTtl,
    } = options
    const useResolve = version === undefined && label === undefined && Boolean(env)
    const key = cacheKey({ id, version, label, env: useResolve ? env : undefined, targetingKey, attributes })
    const cacheEnabled = (cacheTtl ?? this.#cacheTtl) > 0
    const task = async () => {
      if (cacheEnabled) {
        const hot = this.#hotCache.get(key)
        if (hot) return this.#cachePrompt(hot)
        if (!useResolve) {
          const warm = this.#warmCache.get(key)
          if (warm) return this.#cachePrompt(warm)
        }
      }

      if (useResolve && !this.#client.appKey && fallback !== undefined) {
        return ManagedPrompt.fromFallback(fallback, id)
      }

      try {
        const response = useResolve
          ? await this.#client.resolvePrompt({ id, env, targetingKey, attributes })
          : await this.#client.getPrompt({ id, version, label })
        const prompt = ManagedPrompt.fromResponse(response, { label })
        if (cacheEnabled) {
          this.#hotCache.set(key, prompt)
          if (!useResolve) this.#warmCache.set(key, prompt)
        }
        return prompt
      } catch (error) {
        if (cacheEnabled && !useResolve) {
          const warm = this.#warmCache.get(key)
          if (warm) return this.#cachePrompt(warm)
        }
        if (fallback !== undefined) {
          this.#warnFallback(error)
          return ManagedPrompt.fromFallback(fallback, id)
        }
        throw error
      }
    }

    const existing = this.#inFlight.get(key)
    if (existing) return existing
    const promise = task().finally(() => this.#inFlight.delete(key))
    this.#inFlight.set(key, promise)
    return promise
  }

  /**
   * Force retrieval of a prompt, bypassing local caches.
   * @param {string} id
   * @param {{version?: string | number, label?: string}} options
   * @returns {Promise<ManagedPrompt>}
   */
  async refresh (id, { version, label } = {}) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('Prompt id must be a non-empty string')
    const useResolve = version === undefined && label === undefined && Boolean(this.#env)
    const key = cacheKey({ id, version, label, env: useResolve ? this.#env : undefined })
    try {
      const response = useResolve
        ? await this.#client.resolvePrompt({ id, env: this.#env })
        : await this.#client.getPrompt({ id, version, label })
      const prompt = ManagedPrompt.fromResponse(response, { label })
      this.#hotCache.set(key, prompt)
      this.#warmCache.set(key, prompt)
      return prompt
    } catch (error) {
      if (error?.status === 404) this.evictPrompt(id)
      throw error
    }
  }

  /**
   * Clear in-memory and file prompt caches.
   * @returns {void}
   */
  clearCache () {
    this.#hotCache.clear()
    this.#warmCache.clear()
  }

  /**
   * Create a prompt.
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  create (payload) {
    return this.#client.createPrompt(payload)
  }

  /**
   * Create a prompt version.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  createVersion (id, payload) {
    return this.#client.createPromptVersion(id, payload)
  }

  /**
   * Update a prompt.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  update (id, payload) {
    this.#validatePayload(payload)
    return this.#client.updatePrompt(id, payload)
  }

  /**
   * Update a prompt version.
   * @param {string} id
   * @param {string | number} version
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  updateVersion (id, version, payload) {
    this.#validatePayload(payload)
    return this.#client.updatePromptVersion(id, version, payload)
  }

  /**
   * Delete a prompt and evict its caches.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async delete (id) {
    await this.#client.deletePrompt(id)
    this.evictPrompt(id)
  }

  /**
   * List prompts.
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown> | unknown[]>}
   */
  list (params = {}) {
    return this.#client.listPrompts(params)
  }

  /**
   * List prompt versions.
   * @param {string} id
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown> | unknown[]>}
   */
  listVersions (id, params = {}) {
    return this.#client.listPromptVersions(id, params)
  }

  #validatePayload (payload) {
    if (!payload || Object.getOwnPropertyNames(payload).length === 0) {
      throw new TypeError('At least one field must be provided')
    }
  }

  #cachePrompt (prompt) {
    if (prompt instanceof ManagedPrompt) {
      return new ManagedPrompt({ ...prompt._serialize(), source: 'cache' })
    }
    return ManagedPrompt.fromCache(prompt)
  }

  #warnFallback (error) {
    if (this.#warnedFallback) return
    this.#warnedFallback = true
    log.warn('Prompt fetch failed; using fallback: %s', error.message)
  }

  evictPrompt (id) {
    this.#hotCache.evictPrompt(id)
    this.#warmCache.evictPrompt(id)
  }
}

module.exports = { PromptManager }
