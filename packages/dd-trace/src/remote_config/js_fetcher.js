'use strict'

const request = require('../exporters/common/request')
const capabilityMasks = require('./capabilities')
const { UNACKNOWLEDGED } = require('./apply_states')

const configPathRegex = /^(?:datadog\/\d+|employee)\/([^/]+)\/([^/]+)\/([^/]+)$/

/** @typedef {import('./fetcher').RcChangeRecord} RcChangeRecord */
/** @typedef {import('./fetcher').RcFetcherOptions} RcFetcherOptions */

/**
 * Pure-JS client for the Agent Remote Config protocol. It implements the common fetcher contract,
 * so `RemoteConfig` owns the change-record flow for both Agent and agentless transports.
 */
class JsRemoteConfigFetcher {
  /**
   * Per-path protocol bookkeeping: the hashes and length the agent is told are cached, plus the
   * `config_states` entry reported back for it. The parsed config itself is not kept here -- that
   * is `RemoteConfig.appliedConfigs`' job.
   *
   * @type {Map<string, {hashes: Record<string, string>, length: number, state: RcAgentConfigState}>}
   */
  #files = new Map()
  #url
  #timeoutMs
  #state

  /**
   * @param {RcFetcherOptions} options
   */
  constructor (options) {
    this.#url = new URL(options.url)
    this.#timeoutMs = options.timeoutMs
    this.#state = {
      client: {
        state: {
          root_version: 1,
          targets_version: 0,
          config_states: /** @type {RcAgentConfigState[]} */ ([]),
          has_error: false,
          error: '',
          backend_client_state: '',
        },
        id: options.clientId,
        products: /** @type {string[]} */ ([]),
        is_tracer: true,
        client_tracer: {
          runtime_id: options.runtimeId,
          language: options.language,
          tracer_version: options.tracerVersion,
          service: options.service,
          env: options.env,
          app_version: options.appVersion,
          extra_services: /** @type {string[]} */ ([]),
          tags: options.tags,
          process_tags: options.processTags,
        },
        capabilities: encodeCapabilities(0n),
      },
      cached_target_files: /** @type {Array<{path: string, length: number, hashes: object[]}>} */ ([]),
    }
  }

  /**
   * @param {(error: Error|null, changes?: RcChangeRecord[]) => void} callback
   */
  fetchChanges (callback) {
    const options = {
      url: this.#url,
      method: 'POST',
      path: '/v0.7/config',
      timeout: this.#timeoutMs,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    }

    request(this.#payload(), options, (error, data, statusCode) => {
      // 404 means RC is disabled, ignore it
      if (statusCode === 404) return callback(null, [])

      if (error) return callback(error)

      // if error was just sent, reset the state
      if (this.#state.client.state.has_error) {
        this.#state.client.state.has_error = false
        this.#state.client.state.error = ''
      }

      // '{}' means the tracer is up to date
      if (!data || data === '{}') return callback(null, [])

      try {
        callback(null, this.#diff(JSON.parse(data)))
      } catch (parseError) {
        this.#state.client.state.has_error = true
        this.#state.client.state.error = parseError.toString()
        callback(parseError)
      }
    })
  }

  /**
   * @param {string} path
   * @param {number} applyState
   * @param {string} applyError
   */
  setConfigState (path, applyState, applyError) {
    const file = this.#files.get(path)

    if (file === undefined) return

    file.state.apply_state = applyState
    file.state.apply_error = applyError
  }

  /**
   * @param {string[]} services
   */
  setExtraServices (services) {
    this.#state.client.client_tracer.extra_services = services
  }

  /**
   * @param {string[]} products
   * @param {string[]} capabilities - `capabilities.js` keys.
   * @returns {string[]} The capability names this fetcher did not recognize.
   */
  setProductCapabilities (products, capabilities) {
    this.#state.client.products = products

    const unknown = []
    let mask = 0n

    for (const name of capabilities) {
      const capability = capabilityMasks[name]
      if (capability === undefined) {
        unknown.push(name)
      } else {
        mask |= capability
      }
    }

    this.#state.client.capabilities = encodeCapabilities(mask)

    return unknown
  }

  /**
   * `client_configs` is the list of config paths to have applied, `targets` the signed index with
   * metadata for the config files, and `target_files` the files themselves.
   *
   * Removals come first, matching the native client, so a config is torn down before whatever
   * replaces it is applied.
   *
   * @param {{client_configs?: string[], targets?: string, target_files?: Array<{path: string, raw: string}>}} response
   * @returns {RcChangeRecord[]}
   */
  #diff ({ client_configs: clientConfigs = [], targets, target_files: targetFiles = [] }) {
    const changes = /** @type {RcChangeRecord[]} */ ([])
    const files = new Map(this.#files)

    for (const [path, file] of this.#files) {
      if (!clientConfigs.includes(path)) {
        const { product, configId, name } = parseConfigPath(path)
        changes.push({ kind: 'remove', path, product, configId, name, version: file.state.version })
        files.delete(path)
      }
    }

    const decodedTargets = fromBase64JSON(targets)

    if (decodedTargets) {
      for (const path of clientConfigs) {
        const meta = decodedTargets.signed.targets[path]
        if (!meta) throw new Error(`Unable to find target for path ${path}`)

        const known = files.get(path)
        if (known?.hashes.sha256 === meta.hashes.sha256) continue

        const targetFile = targetFiles.find((file) => file.path === path)
        if (!targetFile) throw new Error(`Unable to find file for path ${path}`)

        // TODO: verify signatures, length and _type, and honour `signed.expires`. The native
        //       client verifies the sha256/sha512 hash; none of the rest is checked on either path.

        const { product, configId, name } = parseConfigPath(path)
        const version = meta.custom.v

        changes.push({
          kind: known === undefined ? 'add' : 'update',
          path,
          product,
          configId,
          name,
          version,
          contents: targetFile.raw ? Buffer.from(targetFile.raw, 'base64').toString('utf8') : '',
        })

        files.set(path, {
          hashes: meta.hashes,
          length: meta.length,
          state: {
            id: configId,
            version,
            product,
            apply_state: UNACKNOWLEDGED,
            apply_error: '',
          },
        })
      }

      this.#state.client.state.targets_version = decodedTargets.signed.version
      this.#state.client.state.backend_client_state = decodedTargets.signed.custom.opaque_backend_state
    }

    this.#files = files

    return changes
  }

  #payload () {
    const configStates = []
    const cachedTargetFiles = []

    for (const [path, file] of this.#files) {
      configStates.push(file.state)

      const hashes = []
      for (const [algorithm, hash] of Object.entries(file.hashes)) {
        hashes.push({ algorithm, hash })
      }
      cachedTargetFiles.push({ path, length: file.length, hashes })
    }

    this.#state.client.state.config_states = configStates
    this.#state.cached_target_files = cachedTargetFiles

    return JSON.stringify(this.#state)
  }
}

/**
 * The `config_states` entry reported to the agent for one config.
 *
 * @typedef {object} RcAgentConfigState
 * @property {string} id
 * @property {number} version
 * @property {string} product
 * @property {number} apply_state
 * @property {string} apply_error
 */

/**
 * @param {bigint} mask
 * @returns {string} The big-endian octet string of `mask`, base64 encoded.
 */
function encodeCapabilities (mask) {
  let hex = mask.toString(16)

  if (hex.length % 2) hex = `0${hex}`

  return Buffer.from(hex, 'hex').toString('base64')
}

/**
 * @param {string | undefined} str
 * @returns {object | null}
 */
function fromBase64JSON (str) {
  if (!str) return null

  return JSON.parse(Buffer.from(str, 'base64').toString())
}

/**
 * @param {string} configPath
 * @returns {{product: string, configId: string, name: string}}
 */
function parseConfigPath (configPath) {
  const match = configPathRegex.exec(configPath)

  if (!match) {
    throw new Error(`Unable to parse path ${configPath}`)
  }

  return { product: match[1], configId: match[2], name: match[3] }
}

module.exports = JsRemoteConfigFetcher
