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
 * @typedef {object} AgentlessConfiguration
 * @property {string} apiKey
 * @property {string|undefined} env
 * @property {string|undefined} runtimeId
 * @property {URL} url
 */

/**
 * Writer for agentless APM trace intake.
 * Encodes traces as v0.4 MessagePack and delegates transformation and delivery
 * to the APM data pipeline.
 */
class AgentlessWriter extends BaseWriter {
  #apiKeyMissing = false
  #apiKeyUnsafeReceiver = false
  #deliveriesInFlight = 0
  #exporter
  #exporterApiKey
  #exporterEnv
  #exporterRuntimeId
  #exporterUrl
  #configurationInFlight = false
  #metadata
  #pendingConfigurations
  #pendingStatsDrains
  #stats
  #urlMissing = false

  /**
   * @param {object} options - Writer options
   * @param {URL} [options.url] - The intake URL. If not provided, constructed from site.
   * @param {string} [options.site] - The Datadog site
   * @param {{ endpoint: string, intervalMs: number }} [options.stats] - Client stats configuration
   * @param {object} [options.metadata] - Metadata to pass to the data pipeline
   */
  constructor ({ url, site = 'datadoghq.com', stats, metadata = {} }) {
    super({ url })
    this.#metadata = metadata
    this.#stats = stats
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
    if (url) {
      this.#urlMissing = false
    }
  }

  /**
   * @param {() => void} [done]
   */
  flushAndDrainStats (done = () => {}) {
    super.flush(() => this.#drainStats(done))
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

    this.#deliveriesInFlight++
    let completed = false
    const complete = () => {
      if (completed) return
      completed = true
      this.#deliveriesInFlight--
      this.#flushPendingStatsDrains()
      done()
    }

    // The WASM transport performs its HTTP request in JavaScript. Keep that
    // internal request out of the instrumented application's traces.
    try {
      legacyStorage.run({ noop: true }, () => {
        const { env, runtimeID: runtimeId } = this.#metadata
        this.#applyConfiguration({
          apiKey: DD_API_KEY,
          env,
          runtimeId,
          url: this._url,
        }, (error, exporter) => {
          if (error) {
            const message = error instanceof Error ? error.message : String(error)
            log.error('Failed to send %d trace(s) to the agentless intake: %s', count, message)
            complete()
          } else if (exporter) {
            exporter.sendV04(data, complete, log)
          } else {
            complete()
          }
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Failed to send %d trace(s) to the agentless intake: %s', count, message)
      complete()
    }
  }

  /**
   * @param {AgentlessConfiguration} configuration
   * @param {(error?: unknown, exporter?: import('@datadog/libdatadog').AgentlessExporter) => void} done
   */
  #applyConfiguration (configuration, done) {
    if (this.#configurationInFlight) {
      this.#pendingConfigurations ??= []
      this.#pendingConfigurations.push({ configuration, done })
      return
    }
    const { apiKey, env, runtimeId, url } = configuration
    if (!canSendApiKey(url.protocol, url.hostname)) {
      if (!this.#apiKeyUnsafeReceiver) {
        this.#apiKeyUnsafeReceiver = true
        log.warn('DD_API_KEY will not be sent because the configured receiver is neither HTTPS nor loopback.')
      }
      done()
      return
    }
    this.#apiKeyUnsafeReceiver = false

    if (
      this.#exporter &&
      this.#exporterApiKey === apiKey &&
      this.#exporterEnv === env &&
      this.#exporterRuntimeId === runtimeId &&
      this.#exporterUrl === url.href
    ) {
      done(undefined, this.#exporter)
      return
    }

    this.#configurationInFlight = true
    const replace = () => {
      this.#closeExporter()
      let error
      try {
        const config = getConfig()
        const agent = url.protocol === 'https:' ? getHttpsProxyAgent(url) : undefined
        const endpoint = this.#endpoint(url)
        this.#exporter = createAgentlessExporter({
          endpoint,
          apiKey,
          hostname: this.#metadata.hostname,
          env,
          service: config.service,
          version: config.version,
          runtimeId,
          containerId: this.#metadata.containerId,
          entityId: this.#metadata.entityId,
          tracerVersion,
          languageVersion: process.version,
          languageInterpreter: process.versions.bun ? 'JavaScriptCore' : 'v8',
          stats: this.#stats,
        }, { agent })
        this.#exporterApiKey = apiKey
        this.#exporterEnv = env
        this.#exporterRuntimeId = runtimeId
        this.#exporterUrl = url.href
      } catch (caughtError) {
        error = caughtError
      }
      this.#configurationInFlight = false
      done(error, this.#exporter)
      const pending = this.#pendingConfigurations?.shift()
      if (this.#pendingConfigurations?.length === 0) this.#pendingConfigurations = undefined
      if (pending) this.#applyConfiguration(pending.configuration, pending.done)
    }
    this.#flushExporter(replace)
  }

  /**
   * @param {() => void} done
   */
  #drainStats (done) {
    if (this.#deliveriesInFlight > 0) {
      this.#pendingStatsDrains ??= []
      this.#pendingStatsDrains.push(done)
      return
    }
    this.#flushExporter(done)
  }

  /**
   * @param {() => void} done
   */
  #flushExporter (done) {
    if (typeof this.#exporter?.flush === 'function') {
      this.#exporter.flush(done, log)
    } else {
      done()
    }
  }

  #flushPendingStatsDrains () {
    if (this.#deliveriesInFlight > 0 || !this.#pendingStatsDrains) return
    const pendingStatsDrains = this.#pendingStatsDrains
    this.#pendingStatsDrains = undefined
    this.#flushExporter(() => {
      for (const done of pendingStatsDrains) done()
    })
  }

  /**
   * @param {URL} url
   */
  #endpoint (url) {
    const endpoint = new URL(url)
    endpoint.pathname = INTAKE_PATH
    endpoint.search = ''
    endpoint.hash = ''
    return endpoint.href
  }

  #closeExporter () {
    this.#exporter?.close()
    this.#exporter = undefined
    this.#exporterApiKey = undefined
    this.#exporterEnv = undefined
    this.#exporterRuntimeId = undefined
    this.#exporterUrl = undefined
  }
}

module.exports = AgentlessWriter
