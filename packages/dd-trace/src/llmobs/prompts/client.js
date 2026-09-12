'use strict'

const { PromptAPIError } = require('./errors')
const { escapeId, extractErrorDetail } = require('./util')

const BASE_PATH = '/api/unstable/llm-obs/v1/prompts'

class PromptsClient {
  #apiKey
  #appKey
  #timeout

  /**
   * @param {{apiKey?: string, appKey?: string, site?: string, overrideOrigin?: string, timeout?: number}} options
   */
  constructor ({ apiKey, appKey, site = 'datadoghq.com', overrideOrigin, timeout = 5000 } = {}) {
    this.#apiKey = apiKey
    this.#appKey = appKey
    this.#timeout = timeout
    this.apiBase = (overrideOrigin ?? `https://api.${site}`).replace(/\/$/, '')
    this.basePath = BASE_PATH
  }

  get appKey () {
    return this.#appKey
  }

  /**
   * @param {string} method
   * @param {string} requestPath
   * @param {{body?: unknown, query?: Record<string, unknown>, requireAppKey?: boolean, operation?: string}} options
   * @returns {Promise<Record<string, unknown>>}
   */
  async request (method, requestPath, { body, query, requireAppKey = false, operation = 'prompt operation' } = {}) {
    if (!this.#apiKey) {
      throw new PromptAPIError('DD_API_KEY is required for prompt management', { status: 401 })
    }
    if (requireAppKey && !this.#appKey) {
      throw new PromptAPIError(`DD_APP_KEY is required for ${operation}`, { status: 403 })
    }

    const search = new URLSearchParams()
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) search.set(key, String(value))
      }
    }
    const url = `${this.apiBase}${requestPath}${search.size > 0 ? `?${search}` : ''}`
    const headers = {
      'DD-API-KEY': this.#apiKey,
      'X-Datadog-SDK-Language': 'nodejs',
      'Content-Type': 'application/json',
    }
    if (this.#appKey) headers['DD-APPLICATION-KEY'] = this.#appKey

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      })
    } catch (error) {
      throw new PromptAPIError(`${method} ${requestPath} failed: ${error.message}`, { status: 0 })
    }

    const text = await response.text()
    if (!response.ok) {
      const detail = extractErrorDetail(text)
      throw new PromptAPIError(
        `${method} ${requestPath} failed: HTTP ${response.status} ${detail}`,
        { status: response.status, detail }
      )
    }
    if (!text) return {}

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new PromptAPIError(`${method} ${requestPath} failed: ${error.message}`, { status: response.status })
    }
    return /** @type {Record<string, unknown>} */ (normalizeResponseIds(parsed))
  }

  /**
   * Fetch a prompt from the registry.
   * @param {{id: string, version?: string | number, label?: string}} options
   * @returns {Promise<Record<string, unknown>>}
   */
  getPrompt ({ id, version, label }) {
    const requestPath = version === undefined
      ? `${this.basePath}/${escapeId(id)}`
      : `${this.basePath}/${escapeId(id)}/versions/${encodeURIComponent(version)}`
    return this.request('GET', requestPath, { query: { label } })
  }

  /**
   * Resolve a prompt for an environment and targeting context.
   * @param {{id: string, env: string, targetingKey?: string, attributes?: Record<string, unknown>}} options
   * @returns {Promise<Record<string, unknown>>}
   */
  resolvePrompt ({ id, env, targetingKey, attributes }) {
    const resolved = { env }
    if (targetingKey !== undefined) resolved.targeting_key = targetingKey
    if (attributes) {
      const [firstKey] = Object.getOwnPropertyNames(attributes)
      if (firstKey !== undefined) {
        resolved.context = attributes
      }
    }
    return this.request('POST', `${this.basePath}/${escapeId(id)}/resolve`, {
      body: { data: { type: 'prompt_resolve_requests', attributes: resolved } },
      requireAppKey: true,
      operation: 'resolve',
    })
  }

  /**
   * Create a prompt.
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  createPrompt (payload) {
    return this.request('POST', this.basePath, {
      body: payload, requireAppKey: true, operation: 'prompt write operations',
    })
  }

  /**
   * Create a prompt version.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  createPromptVersion (id, payload) {
    return this.request('POST', `${this.basePath}/${escapeId(id)}/versions`, {
      body: payload,
      requireAppKey: true,
      operation: 'prompt write operations',
    })
  }

  /**
   * Update prompt metadata.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  updatePrompt (id, payload) {
    return this.request('PATCH', `${this.basePath}/${escapeId(id)}`, {
      body: payload,
      requireAppKey: true,
      operation: 'prompt write operations',
    })
  }

  /**
   * Update a prompt version.
   * @param {string} id
   * @param {string | number} version
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  updatePromptVersion (id, version, payload) {
    return this.request('PATCH', `${this.basePath}/${escapeId(id)}/versions/${encodeURIComponent(version)}`, {
      body: payload,
      requireAppKey: true,
      operation: 'prompt write operations',
    })
  }

  /**
   * Delete a prompt.
   * @param {string} id
   * @returns {Promise<Record<string, unknown>>}
   */
  deletePrompt (id) {
    return this.request('DELETE', `${this.basePath}/${escapeId(id)}`, {
      requireAppKey: true,
      operation: 'prompt write operations',
    })
  }

  /**
   * List prompts.
   * @returns {Promise<Record<string, unknown>[]>}
   */
  listPrompts () {
    return /** @type {Promise<Record<string, unknown>[]>} */ (
      /** @type {unknown} */ (this.request('GET', this.basePath))
    )
  }

  /**
   * List prompt versions.
   * @param {string} id
   * @returns {Promise<Record<string, unknown>[]>}
   */
  listPromptVersions (id) {
    return /** @type {Promise<Record<string, unknown>[]>} */ (
      /** @type {unknown} */ (this.request('GET', `${this.basePath}/${escapeId(id)}/versions`))
    )
  }
}

function normalizeResponseIds (response) {
  const normalize = value => {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      value.id === undefined && value.ID !== undefined) {
      return { ...value, id: value.ID }
    }
    return value
  }
  return Array.isArray(response) ? response.map(normalize) : normalize(response)
}

module.exports = { PromptsClient, BASE_PATH }
