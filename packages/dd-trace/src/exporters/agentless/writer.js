'use strict'

const { createAgentlessExporter } = require('@datadog/apm-data-pipeline')

const { storage } = require('../../../../datadog-core')
const getConfig = require('../../config')
const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version

const BaseWriter = require('../common/writer')
const { AgentEncoder } = require('../../encode/0.4')
const { computeIntakeUrl, INTAKE_PATH } = require('./intake')

const legacyStorage = storage('legacy')

/**
 * Writer for agentless APM trace intake.
 * Encodes traces as v0.4 MessagePack and delegates transformation and delivery
 * to the APM data pipeline.
 */
class AgentlessWriter extends BaseWriter {
  #apiKeyMissing = false
  #exporter
  #exporterApiKey
  #exporterEndpoint
  #metadata
  #urlMissing = false

  /**
   * @param {object} options - Writer options
   * @param {URL} [options.url] - The intake URL. If not provided, constructed from site.
   * @param {string} [options.site] - The Datadog site
   * @param {object} [options.metadata] - Metadata to pass to the data pipeline
   */
  constructor ({ url, site = 'datadoghq.com', metadata = {} }) {
    super({ url })
    this.#metadata = metadata
    this._encoder = new AgentEncoder(this)

    if (!url) {
      try {
        this._url = new URL(computeIntakeUrl(site))
      } catch (err) {
        log.error(
          'Invalid site value for agentless intake: %s. Cannot construct URL. Error: %s',
          site,
          err.message
        )
        this._url = undefined
      }
    }

    if (!getConfig().DD_API_KEY) {
      this.#apiKeyMissing = true
      log.error('DD_API_KEY is required for agentless trace intake. Set DD_API_KEY. Traces will not be sent.')
    }
  }

  /**
   * @param {URL} url - The new intake URL.
   * @returns {void}
   */
  setUrl (url) {
    super.setUrl(url)
    this.#closeExporter()
    if (url) {
      this.#urlMissing = false
    }
  }

  /**
   * @param {Buffer} data - v0.4 MessagePack payload.
   * @param {number} count - Number of traces in the payload.
   * @param {Function} done - Callback invoked after delivery completes or fails.
   * @returns {void}
   */
  _sendPayload (data, count, done) {
    if (!this._url) {
      if (!this.#urlMissing) {
        this.#urlMissing = true
        log.error('No valid URL configured for agentless trace intake. Traces will not be sent.')
      }
      log.debug('Dropping %d trace(s) due to missing URL', count)
      done()
      return
    }

    const { DD_API_KEY } = getConfig()
    if (!DD_API_KEY) {
      if (!this.#apiKeyMissing) {
        this.#apiKeyMissing = true
        log.error('DD_API_KEY is required for agentless trace intake. Set DD_API_KEY. Traces will not be sent.')
      }
      log.debug('Dropping %d trace(s) due to missing DD_API_KEY', count)
      done()
      return
    }
    this.#apiKeyMissing = false

    const endpoint = this.#endpoint()
    const exporter = this.#getExporter(endpoint, DD_API_KEY)
    // The WASM fallback performs its HTTP request in JavaScript. Keep that
    // internal request out of the instrumented application's traces.
    legacyStorage.run({ noop: true }, () => exporter.sendV04(data)).then(
      () => done(),
      error => {
        log.error('Failed to send %d trace(s) to the agentless intake: %s', count, error.message)
        done()
      }
    )
  }

  /**
   * @returns {string} The full agentless intake endpoint.
   */
  #endpoint () {
    const endpoint = new URL(this._url)
    endpoint.pathname = INTAKE_PATH
    endpoint.search = ''
    endpoint.hash = ''
    return endpoint.href
  }

  /**
   * @param {string} endpoint - The full agentless intake endpoint.
   * @param {string} apiKey - Datadog API key.
   * @returns {{ sendV04(data: Buffer): Promise<void>, close(): void }} The configured data pipeline exporter.
   */
  #getExporter (endpoint, apiKey) {
    if (this.#exporter && this.#exporterEndpoint === endpoint && this.#exporterApiKey === apiKey) {
      return this.#exporter
    }

    this.#closeExporter()
    const config = getConfig()
    this.#exporter = createAgentlessExporter({
      endpoint,
      apiKey,
      hostname: this.#metadata.hostname,
      env: this.#metadata.env,
      service: config.service,
      version: config.version,
      runtimeId: this.#metadata.runtimeID,
      containerId: this.#metadata.containerId,
      tracerVersion,
      languageVersion: process.version,
      languageInterpreter: process.versions.bun ? 'JavaScriptCore' : 'v8',
    })
    this.#exporterApiKey = apiKey
    this.#exporterEndpoint = endpoint
    return this.#exporter
  }

  /**
   * @returns {void}
   */
  #closeExporter () {
    this.#exporter?.close()
    this.#exporter = undefined
    this.#exporterApiKey = undefined
    this.#exporterEndpoint = undefined
  }
}

module.exports = AgentlessWriter
