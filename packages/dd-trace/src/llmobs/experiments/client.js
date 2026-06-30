'use strict'

// Spike: control-plane HTTP client for LLM Obs Experiments.
//
// Uses the global `fetch` (same approach as src/aiguard/client.js) so the
// experiments module adds no new dependency to dd-trace. Credentials and site
// come from the tracer config (DD_API_KEY / DD_APP_KEY / site), so customers
// configure nothing beyond what the tracer already needs.

const API_BASE_PATH = '/api/v2/llm-obs/v1'

// Control-plane host for a Datadog site, e.g.
//   datadoghq.com        -> api.datadoghq.com
//   us3.datadoghq.com    -> api.us3.datadoghq.com
//   datad0g.com (staging)-> api.datad0g.com
function apiHost (site) {
  return `api.${site}`
}

class ExperimentsClient {
  #apiKey
  #appKey
  #site
  #timeout
  #cachedProjectId

  constructor ({ apiKey, appKey, site, timeout = 30000 } = {}) {
    this.#apiKey = apiKey
    this.#appKey = appKey
    this.#site = site
    this.#timeout = timeout
    this.#cachedProjectId = null
  }

  // Whether the client has everything it needs to talk to the control plane.
  get configured () {
    return Boolean(this.#apiKey && this.#appKey && this.#site)
  }

  // Low-level request. Builds https://api.<site><path>, attaches both keys, and
  // returns the parsed JSON body. Throws with status + body on a non-2xx.
  async request (method, path, body) {
    const url = `https://${apiHost(this.#site)}${path}`
    const headers = {
      'DD-API-KEY': this.#apiKey,
      'DD-APPLICATION-KEY': this.#appKey,
    }

    let payload
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
    }

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.#timeout),
      })
    } catch (err) {
      throw new Error(`${method} ${path} failed: ${err.message}`)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${response.status} ${text}`)
    }
    return text ? JSON.parse(text) : {}
  }

  // Resolve the project id for `name`, creating it if absent. The create
  // endpoint is get-or-create on name, so repeated calls return the same id.
  // Cached after the first resolution.
  async getOrCreateProject (name) {
    if (this.#cachedProjectId) return this.#cachedProjectId

    let response
    try {
      response = await this.request('POST', `${API_BASE_PATH}/projects`, {
        data: { type: 'projects', attributes: { name } },
      })
    } catch (err) {
      throw new Error(`Failed to create or get project '${name}': ${err.message}`)
    }

    this.#cachedProjectId = response?.data?.id ?? null
    return this.#cachedProjectId
  }
}

module.exports = { ExperimentsClient, apiHost, API_BASE_PATH }
