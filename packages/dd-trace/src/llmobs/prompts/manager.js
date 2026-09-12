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
    const hasAttributes = attributes && Reflect.ownKeys(attributes).length > 0
    if (version !== undefined && (label !== undefined || targetingKey !== undefined || hasAttributes)) {
      log.warn('Prompt get version takes precedence over label, targetingKey, and attributes')
    } else if (label !== undefined && (targetingKey !== undefined || hasAttributes)) {
      log.warn('Prompt get label takes precedence over targetingKey and attributes')
    }
    const useResolve = version === undefined && label === undefined && Boolean(env)
    const selector = version === undefined
      ? label === undefined
        ? { env: useResolve ? env : undefined, targetingKey, attributes }
        : { label }
      : { version }
    const key = cacheKey({ id, ...selector })
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
          : await this.#client.getPrompt({
            id,
            version,
            label: version === undefined ? label : undefined,
          })
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
      if (!useResolve) this.#warmCache.set(key, prompt)
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
   * @param {import('../../../../../index').llmobs.PromptCreateOptions} [options]
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse>}
   */
  create (options) {
    const { id, template, title, description, userVersion, labels, envIds } = options ?? {}
    if (typeof id !== 'string' || id.length === 0 || template === undefined) {
      throw new TypeError('id and template are required')
    }
    return this.#write(id, this.#client.createPrompt(withoutUndefined({
      prompt_id: id,
      template,
      title,
      description,
      user_version: userVersion,
      labels,
      env_ids: envIds,
    })))
  }

  /**
   * Create a prompt version.
   * @param {string} id
   * @param {import('../../../../../index').llmobs.PromptVersionCreateOptions} [options]
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse>}
   */
  createVersion (id, options) {
    const { template, description, userVersion, labels, envIds } = options ?? {}
    if (template === undefined) throw new TypeError('template is required')
    return this.#write(id, this.#client.createPromptVersion(id, withoutUndefined({
      template,
      description,
      user_version: userVersion,
      labels,
      env_ids: envIds,
    })))
  }

  /**
   * Update a prompt.
   * @param {string} id
   * @param {import('../../../../../index').llmobs.PromptUpdateOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse>}
   */
  update (id, { title, description } = {}) {
    if (title === undefined && description === undefined) {
      throw new TypeError('At least one of title or description must be provided')
    }
    return this.#write(id, this.#client.updatePrompt(id, withoutUndefined({ title, description })))
  }

  /**
   * Update a prompt version.
   * @param {string} id
   * @param {string | number} version
   * @param {import('../../../../../index').llmobs.PromptVersionUpdateOptions} options
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse>}
   */
  updateVersion (id, version, { labels, description, envIds } = {}) {
    if (labels === undefined && description === undefined && envIds === undefined) {
      throw new TypeError('At least one of labels, description, or envIds must be provided')
    }
    return this.#write(id, this.#client.updatePromptVersion(id, version, withoutUndefined({
      labels,
      description,
      env_ids: envIds,
    })))
  }

  /**
   * Delete a prompt and evict its caches.
   * @param {string} id
   * @returns {Promise<import('../../../../../index').llmobs.DeletedPromptResponse>}
   */
  async delete (id) {
    const response = await this.#client.deletePrompt(id)
    this.evictPrompt(id)
    return response
  }

  /**
   * List prompts.
   * @returns {Promise<import('../../../../../index').llmobs.PromptResponse[]>}
   */
  list () {
    return this.#client.listPrompts()
  }

  /**
   * List prompt versions.
   * @param {string} id
   * @returns {Promise<import('../../../../../index').llmobs.PromptVersionResponse[]>}
   */
  listVersions (id) {
    return this.#client.listPromptVersions(id)
  }

  #write (id, request) {
    return Promise.resolve(request).then(response => {
      this.evictPrompt(id)
      return response
    })
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

function withoutUndefined (value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
