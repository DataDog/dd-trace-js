'use strict'

const { storage } = require('../../../../datadog-core')
const getConfig = require('../../config')
const { AgentEncoder } = require('../../encode/0.4')
const log = require('../../log')
const { MAX_SIZE } = require('../../msgpack')
const tracerVersion = require('../../../../../package.json').version

const { canSendApiKey } = require('../common/url')
const { getHttpsProxyAgent } = require('../common/proxy')
const BaseWriter = require('../common/writer')
const { computeIntakeUrl, INTAKE_PATH } = require('./intake')

const legacyStorage = storage('legacy')
const languageInterpreter = process.versions.bun ? 'JavaScriptCore' : 'v8'
const PINNED_EXPORTER_USER_AGENT = 'Tracer/11.0.0'
let compress
let createPolicy

function createCompressor () {
  const zlib = require('node:zlib')
  if (typeof zlib.zstdCompressSync === 'function') {
    const { zstdCompressSync, constants } = zlib
    const options = { params: { [constants.ZSTD_c_compressionLevel]: 1 } }
    /** @param {Buffer} payload */
    return payload => zstdCompressSync(payload, options)
  }
  const { zstd_compress: zstdCompress } = require('@datadog/libdatadog')
  /** @param {Buffer} payload */
  return payload => zstdCompress(payload, 1)
}

/**
 * Writer for agentless APM trace intake.
 * Encodes traces as v0.4 MessagePack. The configured policy prepares the
 * payload before delivery to the intake.
 */
class AgentlessWriter extends BaseWriter {
  #apiKeyMissing = false
  #apiKeyUnsafeReceiver = false
  #directTransport
  #exporter
  #exporterApiKey
  #exporterEnv
  #exporterRuntimeId
  #generatedObfuscation
  #metadata
  #policy
  #urlMissing = false

  /**
   * @param {object} options - Writer options
   * @param {URL} [options.url] - The intake URL. If not provided, constructed from site.
   * @param {string} [options.site] - The Datadog site
   * @param {object} [options.metadata] - Metadata to pass to the data pipeline
   * @param {boolean} [options.generatedObfuscation]
   */
  constructor ({ url, site = 'datadoghq.com', metadata = {}, generatedObfuscation = false }) {
    super({ url })
    this.#metadata = metadata
    this.#generatedObfuscation = generatedObfuscation
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
   * @param {Buffer} data - Encoded v0.4 batch.
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

    if (!canSendApiKey(this._url.protocol, this._url.hostname)) {
      if (!this.#apiKeyUnsafeReceiver) {
        this.#apiKeyUnsafeReceiver = true
        log.warn('DD_API_KEY will not be sent because the configured receiver is neither HTTPS nor loopback.')
      }
      done()
      return
    }
    this.#apiKeyUnsafeReceiver = false

    try {
      const sending = legacyStorage.run({ noop: true }, () => {
        this.#refreshConfiguration(DD_API_KEY)
        if (!this.#generatedObfuscation) {
          this.#getLegacyExporter(DD_API_KEY).sendV04(data, done, log)
          return true
        }

        const json = this.#preparePayload(data)
        if (json === undefined || json.byteLength > MAX_SIZE) {
          log.error('Agentless policy declined %d trace(s); dropping the batch', count)
          return false
        }

        if (!this.#directTransport) {
          const DirectTransport = require('./direct-transport')
          this.#directTransport = new DirectTransport()
        }
        /** @type {Record<string, string>} */
        const headers = {
          'content-type': 'application/json',
          'content-encoding': 'zstd',
          'dd-api-key': DD_API_KEY,
          'datadog-meta-lang': 'nodejs',
          'datadog-meta-lang-version': process.version,
          'datadog-meta-lang-interpreter': languageInterpreter,
          'datadog-meta-tracer-version': tracerVersion,
          'user-agent': PINNED_EXPORTER_USER_AGENT,
          'x-datadog-trace-count': String(count),
        }
        if (this.#metadata.containerId) {
          headers['datadog-container-id'] = this.#metadata.containerId
        }
        compress ??= createCompressor()
        this.#directTransport.send(compress(json), {
          url: this._url,
          path: INTAKE_PATH,
          method: 'POST',
          headers,
        }, failure => {
          if (typeof failure === 'number') {
            log.errorWithoutTelemetry('Failed to send %d trace(s) to the agentless intake: HTTP %d', count, failure)
          } else if (failure) {
            log.error('Failed to send %d trace(s) to the agentless intake: %s', count, failure.message)
          }
          done()
        })
        return true
      })
      if (sending) return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Failed to send %d trace(s) to the agentless intake: %s', count, message)
    }
    done()
  }

  /** @param {Buffer} data */
  #preparePayload (data) {
    if (!this.#policy) {
      if (!createPolicy) {
        const loadPolicy = require('./generated/agentless-policy.cjs')
        createPolicy = loadPolicy()
      }
      this.#policy = createPolicy({}, {
        hostname: this.#metadata.hostname ?? '',
        env: this.#exporterEnv ?? '',
        language: 'nodejs',
        languageVersion: process.version,
        tracerVersion,
        runtimeID: this.#exporterRuntimeId ?? require('node:crypto').randomUUID(),
      })
    }
    return this.#policy.prepare(data)
  }

  #endpoint () {
    const endpoint = new URL(this._url)
    endpoint.pathname = INTAKE_PATH
    endpoint.search = ''
    endpoint.hash = ''
    return endpoint.href
  }

  /** @param {string} apiKey */
  #refreshConfiguration (apiKey) {
    const { env, runtimeID } = this.#metadata
    if (
      this.#exporterApiKey === apiKey &&
      this.#exporterEnv === env &&
      this.#exporterRuntimeId === runtimeID
    ) {
      return
    }

    this.#closeExporter()
    this.#exporterApiKey = apiKey
    this.#exporterEnv = env
    this.#exporterRuntimeId = runtimeID
  }

  /** @param {string} apiKey */
  #getLegacyExporter (apiKey) {
    if (this.#exporter) {
      return this.#exporter
    }
    const { createAgentlessExporter } = require('@datadog/libdatadog')
    const config = getConfig()
    const agent = this._url.protocol === 'https:' ? getHttpsProxyAgent(this._url) : undefined
    this.#exporter = createAgentlessExporter({
      endpoint: this.#endpoint(),
      apiKey,
      hostname: this.#metadata.hostname,
      env: this.#exporterEnv,
      service: config.service,
      version: config.version,
      runtimeId: this.#exporterRuntimeId,
      containerId: this.#metadata.containerId,
      tracerVersion,
      languageVersion: process.version,
      languageInterpreter,
    }, { agent })
    return this.#exporter
  }

  #closeExporter () {
    this.#policy = undefined
    this.#directTransport?.close()
    this.#directTransport = undefined
    this.#exporter?.close()
    this.#exporter = undefined
    this.#exporterApiKey = undefined
    this.#exporterEnv = undefined
    this.#exporterRuntimeId = undefined
  }
}

module.exports = AgentlessWriter
