'use strict'

const log = require('../../log')
const { getEnvironmentVariable } = require('../../config/helper')
const { isLoopbackHost } = require('../../exporters/common/url')
const telemetry = require('../telemetry')
const { HotCache, WarmCache, cacheKey } = require('./cache')
const ManagedPrompt = require('./prompt')

const PROMPTS_PATH = '/api/unstable/llm-obs/v1/prompts'
const SOURCE_CACHE = 'cache'

/**
 * @typedef {object} PromptRequest
 * @property {string} promptId
 * @property {string | number | undefined} version
 * @property {string | undefined} env
 * @property {string | undefined} targetingKey
 * @property {Record<string, unknown>} attributes
 * @property {string} key
 * @property {boolean} resolve
 */

/**
 * @typedef {object} PromptFetchResult
 * @property {ManagedPrompt} [prompt]
 * @property {string} [reason]
 * @property {boolean} [notFound]
 * @property {boolean} [cacheable]
 */

function isPlainObject (value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Build a canonical prompt selector.
 * @param {string} promptId
 * @param {object} [options]
 * @param {string | number} [options.version]
 * @param {string} [options.env]
 * @param {string} [options.targetingKey]
 * @param {Record<string, unknown>} [options.attributes]
 */
function promptRequest (promptId, { version, env, targetingKey, attributes = {} } = {}) {
  const requestAttributes = { ...attributes }
  let selector
  if (version !== undefined) selector = ['version', version]
  else if (env) {
    const attributesSelector = Object.keys(requestAttributes).sort().map(key => [key, requestAttributes[key]])
    selector = ['resolve', env, targetingKey ?? null, attributesSelector]
  } else selector = ['latest']

  return {
    promptId,
    version,
    env,
    targetingKey,
    attributes: requestAttributes,
    key: cacheKey(promptId, selector),
    resolve: version === undefined && Boolean(env),
  }
}

function promptFromData (data, source) {
  if (!isPlainObject(data) || !data.prompt_id) return
  const version = data.user_version || data.version
  if (!version) return
  return new ManagedPrompt({
    id: data.prompt_id,
    version: String(version),
    source,
    template: data.template || data.chat_template || [],
    promptUuid: data.prompt_uuid,
    promptVersionUuid: data.prompt_version_uuid || data.id || data.ID,
  })
}

/**
 * Copy a prompt with a different source.
 * @param {ManagedPrompt} prompt
 * @param {'registry'|'cache'|'fallback'|'ff'|'resolve'} source
 */
function withSource (prompt, source) {
  if (source === prompt.source) return prompt
  return new ManagedPrompt({ ...prompt, source })
}

function detailFromBody (body) {
  try {
    return JSON.parse(body)?.detail ?? body
  } catch {
    return body
  }
}

function errorName (status) {
  if (status === 400) return 'PromptValidationError'
  if (status === 401 || status === 403) return 'PromptAuthError'
  if (status === 404) return 'PromptNotFoundError'
  if (status === 409) return 'PromptConflictError'
  if (status >= 500) return 'PromptServerError'
  return 'PromptAPIError'
}

class PromptAPIError extends Error {
  /**
   * Create a typed Prompt Management API error.
   * @param {number} status
   * @param {string} detail
   * @param {string} [name]
   */
  constructor (status, detail, name = errorName(status)) {
    super(`Prompt API error (${status}): ${detail}`)
    this.name = name
    this.status = status
    this.detail = detail
  }
}

function normalizeItem (item) {
  if (!isPlainObject(item)) return item
  const { ID, labels, ...normalized } = item
  if (normalized.id === undefined && ID !== undefined) normalized.id = ID
  return normalized
}

function normalizeResponse (data) {
  return Array.isArray(data) ? data.map(normalizeItem) : normalizeItem(data)
}

function requestSignal (timeoutMs, cacheSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!cacheSignal) return timeoutSignal
  const controller = new AbortController()
  cacheSignal.addEventListener('abort', () => controller.abort(cacheSignal.reason), { once: true })
  timeoutSignal.addEventListener('abort', () => controller.abort(timeoutSignal.reason), { once: true })
  return controller.signal
}

class PromptManager {
  /**
   * @param {import('../../config/config-base')} config
   * @param {() => object} getProvider
   */
  constructor (config, getProvider) {
    this.config = config
    this.getProvider = getProvider
    this.ttlMs = Math.round(config.DD_LLMOBS_PROMPTS_CACHE_TTL * 1000)
    this.timeoutMs = Math.round(config.DD_LLMOBS_PROMPTS_TIMEOUT * 1000)
    const origin = getEnvironmentVariable('_DD_LLMOBS_OVERRIDE_ORIGIN') || `https://api.${config.site}`
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'https:' && !(protocol === 'http:' && isLoopbackHost(hostname))) {
      throw new PromptAPIError(0, 'Prompt origin must use HTTPS unless it targets a loopback host', 'PromptAuthError')
    }
    this.origin = origin
    this.cacheGeneration = 0
    this.fetchTokens = new Map()
    this.pendingFetches = new Map()
    this.hotCache = new HotCache({
      ttlMs: this.ttlMs,
      fetchMethod: (key, stale, { context, signal }) => this.#backgroundFetch(key, context, signal),
    })
    this.warmCache = new WarmCache({
      cacheDir: config.DD_LLMOBS_PROMPTS_CACHE_DIR,
      enabled: config.DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED && this.ttlMs > 0,
      ttlMs: this.ttlMs,
    })
  }

  /**
   * Require API authentication before using any prompt path.
   */
  #requireApiKey () {
    if (!this.config.DD_API_KEY) {
      throw new PromptAPIError(0, 'DD_API_KEY is required for prompt operations', 'PromptAuthError')
    }
    return this.config.DD_API_KEY
  }

  /**
   * Build a Prompt Management URL.
   * @param {string} path
   */
  #url (path) {
    return `${this.origin.replace(/\/$/, '')}${path}`
  }

  /**
   * Evaluate a prompt through the tracer's existing OpenFeature provider.
   * @param {PromptRequest} request
   * @returns {Promise<ManagedPrompt | undefined>}
   */
  async #fetchFromProvider (request) {
    let prompt
    try {
      const context = { ...request.attributes }
      if (request.targetingKey !== undefined) context.targetingKey = request.targetingKey
      const details = await this.getProvider().resolveObjectEvaluation(
        `__llmobs__.prompt.${request.promptId}`,
        {},
        context,
        log
      )
      prompt = promptFromData(details.value, 'ff')
    } catch (error) {
      log.debug('Feature Flag prompt evaluation failed for %s: %s', request.promptId, error.message)
    }
    return prompt
  }

  /**
   * Fetch a prompt from the registry or resolve endpoint.
   * @param {PromptRequest} request
   * @param {AbortSignal} [cacheSignal]
   * @returns {Promise<PromptFetchResult>}
   */
  async #fetchHttp (request, cacheSignal) {
    const apiKey = this.#requireApiKey()
    if (request.resolve && !this.config.DD_APP_KEY) {
      return { reason: 'DD_APP_KEY is required to resolve prompts for an environment' }
    }

    const encodedId = encodeURIComponent(request.promptId)
    let method = 'GET'
    let path = `${PROMPTS_PATH}/${encodedId}`
    let body
    const headers = {
      'DD-API-KEY': apiKey,
      'X-Datadog-SDK-Language': 'javascript',
    }

    if (request.resolve) {
      method = 'POST'
      path += '/resolve'
      const attributes = { env: request.env }
      if (request.targetingKey !== undefined) attributes.targeting_key = request.targetingKey
      if (Object.entries(request.attributes).length > 0) attributes.context = request.attributes
      body = JSON.stringify({ data: { type: 'prompt_resolve_requests', attributes } })
      headers['Content-Type'] = 'application/json'
      headers['DD-APPLICATION-KEY'] = this.config.DD_APP_KEY
    } else if (request.version !== undefined) {
      path += `/versions/${request.version}`
    }

    try {
      const response = await fetch(this.#url(path), {
        method,
        headers,
        body,
        signal: requestSignal(this.timeoutMs, cacheSignal),
      })
      const responseBody = await response.text()
      if (response.ok) {
        let data
        try {
          data = JSON.parse(responseBody)
        } catch {
          return { reason: 'invalid JSON in response body' }
        }
        const source = request.resolve ? 'resolve' : 'registry'
        const prompt = promptFromData(data, source)
        return prompt ? { prompt } : { reason: 'invalid prompt response' }
      }

      const detail = detailFromBody(responseBody)
      if (response.status === 404) {
        log.debug('Prompt not found: prompt_id=%s detail="%s"', request.promptId, detail)
        return { reason: detail, notFound: true }
      }
      log.warn('Prompt fetch failed: prompt_id=%s status=%d detail="%s"', request.promptId, response.status, detail)
      return { reason: detail }
    } catch (error) {
      if (cacheSignal?.aborted) return { reason: 'fetch cancelled' }
      log.warn('Prompt fetch exception: prompt_id=%s: %s', request.promptId, error.message)
      return { reason: error.message }
    }
  }

  /**
   * Fetch and cache one selector.
   * @param {PromptRequest} request
   * @param {{evictOnNotFound?: boolean, hot?: boolean, signal?: AbortSignal}} [options]
   * @returns {Promise<PromptFetchResult>}
   */
  async #fetchAndCache (request, { evictOnNotFound = false, hot = true, signal } = {}) {
    const generation = this.cacheGeneration
    const token = Symbol(request.key)
    this.fetchTokens.set(request.key, token)
    const result = await this.#fetchHttp(request, signal)
    const latest = this.fetchTokens.get(request.key) === token
    if (latest) this.fetchTokens.delete(request.key)
    const cacheable = generation === this.cacheGeneration && latest
    if (result.prompt) {
      if (this.ttlMs > 0 && cacheable) {
        const cached = withSource(result.prompt, SOURCE_CACHE)
        if (hot) this.hotCache.set(request.key, cached)
        if (!request.resolve) this.warmCache.set(request.key, cached)
      }
      return { ...result, cacheable }
    }

    if (signal?.aborted) return { ...result, cacheable }
    telemetry.recordPromptFetchError(result.notFound ? 'NotFound' : 'FetchError')
    if (result.notFound && evictOnNotFound && cacheable) {
      this.hotCache.delete(request.key)
      this.warmCache.delete(request.key)
    }
    return { ...result, cacheable }
  }

  /**
   * Refresh one stale hot-cache entry.
   * @param {string} key
   * @param {PromptRequest} request
   * @param {AbortSignal} signal
   * @returns {Promise<ManagedPrompt | undefined>}
   */
  async #backgroundFetch (key, request, signal) {
    const result = await this.#fetchAndCache(request, { evictOnNotFound: true, hot: false, signal })
    if (!result.cacheable) return
    if (result.prompt) return withSource(result.prompt, SOURCE_CACHE)
    if (result.notFound) return
    throw new Error(result.reason)
  }

  /**
   * Resolve a prompt from caches, HTTP, or a caller fallback.
   * @param {PromptRequest} request
   * @param {string | object | Array<{role: string, content: string}> |
   *   (() => string | object | Array<{role: string, content: string}>) | undefined} fallback
   * @returns {Promise<ManagedPrompt>}
   */
  async #getHttpPrompt (request, fallback) {
    if (this.ttlMs > 0) {
      const hot = this.hotCache.get(request.key)
      if (hot) {
        if (hot.stale) this.hotCache.refresh(request.key, request)
        telemetry.recordPromptSource('hot_cache')
        return hot.prompt
      }

      if (!request.resolve) {
        const warm = this.warmCache.get(request.key)
        if (warm) {
          this.hotCache.set(request.key, warm.prompt, warm.ageMs)
          if (warm.stale) this.hotCache.refresh(request.key, request)
          telemetry.recordPromptSource('warm_cache')
          return warm.prompt
        }
      }
    }

    let pending = this.pendingFetches.get(request.key)
    if (!pending) {
      pending = this.#fetchAndCache(request)
      this.pendingFetches.set(request.key, pending)
    }
    let result
    try {
      result = await pending
    } finally {
      if (this.pendingFetches.get(request.key) === pending) this.pendingFetches.delete(request.key)
    }
    if (result.prompt) {
      telemetry.recordPromptSource(request.resolve ? 'resolve' : 'registry')
      return result.prompt
    }

    if (fallback === undefined) {
      const reason = result.reason ? `: ${result.reason}` : ''
      throw new Error(`Prompt '${request.promptId}' could not be fetched and no fallback was provided${reason}`)
    }
    const prompt = ManagedPrompt.fromFallback(request.promptId, fallback)
    telemetry.recordPromptSource('fallback')
    return prompt
  }

  /**
   * Get a prompt by exact version or current environment.
   * @param {string} promptId
   * @param {object} [options]
   * @param {string | number} [options.version]
   * @param {string | object | Array<{role: string, content: string}> |
   *   (() => string | object | Array<{role: string, content: string}>)} [options.fallback]
   * @param {string} [options.targetingKey]
   * @param {Record<string, unknown>} [options.attributes]
   * @returns {Promise<ManagedPrompt>}
   */
  async getPrompt (promptId, options = {}) {
    this.#requireApiKey()
    const { version, fallback, targetingKey, attributes = {} } = options
    if (version !== undefined) {
      return this.#getHttpPrompt(promptRequest(promptId, { version }), fallback)
    }

    const request = promptRequest(promptId, {
      env: this.config.env,
      targetingKey,
      attributes,
    })
    if (request.resolve) {
      const prompt = await this.#fetchFromProvider(request)
      if (prompt) {
        telemetry.recordPromptSource('ff')
        return prompt
      }
    }
    return this.#getHttpPrompt(request, fallback)
  }

  /**
   * Refresh the selector implied by the configured environment.
   * @param {string} promptId
   * @returns {Promise<ManagedPrompt | undefined>}
   */
  async refreshPrompt (promptId) {
    this.#requireApiKey()
    const request = promptRequest(promptId, { env: this.config.env })
    this.pendingFetches.delete(request.key)
    const result = await this.#fetchAndCache(request, { evictOnNotFound: true })
    return result.prompt
  }

  /**
   * Clear hot and/or warm prompt caches.
   * @param {{hot?: boolean, warm?: boolean}} [options]
   */
  clearCache ({ hot = true, warm = true } = {}) {
    this.cacheGeneration++
    this.pendingFetches.clear()
    if (hot) this.hotCache.clear()
    if (warm) this.warmCache.clear()
  }

  /**
   * Evict every cached selector for one exact prompt ID.
   * @param {string} promptId
   */
  #evictPrompt (promptId) {
    this.cacheGeneration++
    this.pendingFetches.clear()
    this.hotCache.evictPrompt(promptId)
    this.warmCache.evictPrompt(promptId)
  }

  /**
   * Record a Prompt Management CRUD error.
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {PromptAPIError} error
   */
  #recordCrudError (method, error) {
    telemetry.recordPromptCrudError(method, error.name, error.status)
    return error
  }

  /**
   * Execute one CRUD request and normalize its response.
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {string} path
   * @param {object | undefined} body
   * @param {boolean} requireAppKey
   * @returns {Promise<object | object[]>}
   */
  async #request (method, path, body, requireAppKey) {
    try {
      const apiKey = this.#requireApiKey()
      if (requireAppKey && !this.config.DD_APP_KEY) {
        throw new PromptAPIError(0, 'DD_APP_KEY is required for prompt write operations', 'PromptAuthError')
      }

      const headers = {
        'Content-Type': 'application/json',
        'DD-API-KEY': apiKey,
        'X-Datadog-SDK-Language': 'javascript',
      }
      if (requireAppKey) headers['DD-APPLICATION-KEY'] = this.config.DD_APP_KEY

      let response
      try {
        response = await fetch(this.#url(path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error) {
        throw new PromptAPIError(0, error.message)
      }

      const responseBody = await response.text()
      if (!response.ok) throw new PromptAPIError(response.status, detailFromBody(responseBody))
      if (!responseBody) return {}
      try {
        return normalizeResponse(JSON.parse(responseBody))
      } catch {
        throw new PromptAPIError(response.status, 'invalid JSON in response body', 'PromptServerError')
      }
    } catch (error) {
      const promptError = error instanceof PromptAPIError ? error : new PromptAPIError(0, error.message)
      throw this.#recordCrudError(method, promptError)
    }
  }

  /**
   * Create a prompt and its first version.
   * @param {string} promptId
   * @param {Array<{role: string, content: string}>} template
   * @param {{title?: string, description?: string, userVersion?: string, envIds?: string[]}} [options]
   * @returns {Promise<object | object[]>}
   */
  async createPrompt (promptId, template, options = {}) {
    const body = { prompt_id: promptId, template }
    if (options.title) body.title = options.title
    if (options.description) body.description = options.description
    if (options.userVersion) body.user_version = options.userVersion
    if (options.envIds !== undefined) body.env_ids = options.envIds
    const response = await this.#request('POST', PROMPTS_PATH, body, true)
    this.#evictPrompt(promptId)
    return response
  }

  /**
   * Add a version to an existing prompt.
   * @param {string} promptId
   * @param {Array<{role: string, content: string}>} template
   * @param {{description?: string, userVersion?: string, envIds?: string[]}} [options]
   * @returns {Promise<object | object[]>}
   */
  async createPromptVersion (promptId, template, options = {}) {
    const body = { template }
    if (options.description) body.description = options.description
    if (options.userVersion) body.user_version = options.userVersion
    if (options.envIds !== undefined) body.env_ids = options.envIds
    const path = `${PROMPTS_PATH}/${encodeURIComponent(promptId)}/versions`
    const response = await this.#request('POST', path, body, true)
    this.#evictPrompt(promptId)
    return response
  }

  /**
   * Update prompt metadata.
   * @param {string} promptId
   * @param {{title?: string, description?: string}} [options]
   * @returns {Promise<object | object[]>}
   */
  async updatePrompt (promptId, options = {}) {
    try {
      this.#requireApiKey()
    } catch (error) {
      throw this.#recordCrudError('PATCH', error)
    }
    if (options.title === undefined && options.description === undefined) {
      const error = new PromptAPIError(0, 'At least one of title or description must be provided',
        'PromptValidationError')
      throw this.#recordCrudError('PATCH', error)
    }
    const body = {}
    if (options.title !== undefined) body.title = options.title
    if (options.description !== undefined) body.description = options.description
    const response = await this.#request('PATCH', `${PROMPTS_PATH}/${encodeURIComponent(promptId)}`, body, true)
    this.#evictPrompt(promptId)
    return response
  }

  /**
   * Update prompt-version metadata.
   * @param {string} promptId
   * @param {number} version
   * @param {{description?: string, envIds?: string[]}} [options]
   * @returns {Promise<object | object[]>}
   */
  async updatePromptVersion (promptId, version, options = {}) {
    try {
      this.#requireApiKey()
    } catch (error) {
      throw this.#recordCrudError('PATCH', error)
    }
    if (options.description === undefined && options.envIds === undefined) {
      const error = new PromptAPIError(0, 'At least one of description or envIds must be provided',
        'PromptValidationError')
      throw this.#recordCrudError('PATCH', error)
    }
    const body = {}
    if (options.description !== undefined) body.description = options.description
    if (options.envIds !== undefined) body.env_ids = options.envIds
    const path = `${PROMPTS_PATH}/${encodeURIComponent(promptId)}/versions/${version}`
    const response = await this.#request('PATCH', path, body, true)
    this.#evictPrompt(promptId)
    return response
  }

  /**
   * Delete a prompt.
   * @param {string} promptId
   * @returns {Promise<object | object[]>}
   */
  async deletePrompt (promptId) {
    const response = await this.#request('DELETE', `${PROMPTS_PATH}/${encodeURIComponent(promptId)}`, undefined, true)
    this.#evictPrompt(promptId)
    return response
  }

  /**
   * List prompts.
   * @returns {Promise<object | object[]>}
   */
  listPrompts () {
    return this.#request('GET', PROMPTS_PATH, undefined, false)
  }

  /**
   * List versions for a prompt.
   * @param {string} promptId
   * @returns {Promise<object | object[]>}
   */
  listPromptVersions (promptId) {
    return this.#request('GET', `${PROMPTS_PATH}/${encodeURIComponent(promptId)}/versions`, undefined, false)
  }
}

module.exports = PromptManager
