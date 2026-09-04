'use strict'

const { createAgentlessExporter } = require('@datadog/libdatadog')

const { storage } = require('../../../../datadog-core')
const getConfig = require('../../config')
const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version

const { canSendApiKey } = require('../common/url')
const { getHttpsProxyAgent } = require('../common/proxy')
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
  #apiKeyUnsafeReceiver = false
  #exporter
  #exporterApiKey
  #exporterEnv
  #exporterRuntimeId
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
      } catch (error) {
        log.error(
          'Invalid site value for agentless intake: %s. Cannot construct URL. Error: %s',
          site,
          error.message
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
   * @param {() => void} done - Callback invoked after delivery completes or fails.
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

    // The WASM transport performs its HTTP request in JavaScript. Keep that
    // internal request out of the instrumented application's traces.
    try {
      legacyStorage.run({ noop: true }, () => {
        const exporter = this.#applyConfiguration(DD_API_KEY)
        if (exporter) {
          exporter.sendV04(data, done, log)
        } else {
          done()
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Failed to send %d trace(s) to the agentless intake: %s', count, message)
      done()
    }
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
   * @param {string} apiKey - Datadog API key.
   * @returns {import('@datadog/libdatadog').AgentlessExporter|undefined}
   */
  #applyConfiguration (apiKey) {
    if (!canSendApiKey(this._url.protocol, this._url.hostname)) {
      if (!this.#apiKeyUnsafeReceiver) {
        this.#apiKeyUnsafeReceiver = true
        log.warn('DD_API_KEY will not be sent because the configured receiver is neither HTTPS nor loopback.')
      }
      return
    }
    this.#apiKeyUnsafeReceiver = false

    const { env, runtimeID } = this.#metadata
    if (
      this.#exporter &&
      this.#exporterApiKey === apiKey &&
      this.#exporterEnv === env &&
      this.#exporterRuntimeId === runtimeID
    ) {
      return this.#exporter
    }

    this.#closeExporter()
    const config = getConfig()
    const agent = this._url.protocol === 'https:' ? getHttpsProxyAgent(this._url) : undefined
    this.#exporter = createAgentlessExporter({
      endpoint: this.#endpoint(),
      apiKey,
      hostname: this.#metadata.hostname,
      env,
      service: config.service,
      version: config.version,
      runtimeId: runtimeID,
      containerId: this.#metadata.containerId,
      tracerVersion,
      languageVersion: process.version,
      languageInterpreter: process.versions.bun ? 'JavaScriptCore' : 'v8',
    }, { agent })
    this.#exporterApiKey = apiKey
    this.#exporterEnv = env
    this.#exporterRuntimeId = runtimeID
    return this.#exporter
  }

  #closeExporter () {
    this.#exporter?.close()
    this.#exporter = undefined
    this.#exporterApiKey = undefined
    this.#exporterEnv = undefined
    this.#exporterRuntimeId = undefined
  }
}

module.exports = AgentlessWriter
