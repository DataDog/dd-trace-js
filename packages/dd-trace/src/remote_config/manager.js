'use strict'

const { URL, format } = require('url')
const uuid = require('../../../../vendor/dist/crypto-randomuuid')
const tracerVersion = require('../../../../package.json').version
const request = require('../exporters/common/request')
const log = require('../log')
const { getExtraServices } = require('../service-naming/extra-services')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('./apply_states')
const Scheduler = require('./scheduler')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../plugins/util/tags')
const tagger = require('../tagger')
const defaults = require('../config_defaults')
const processTags = require('../process-tags')

const clientId = uuid()

const DEFAULT_CAPABILITY = Buffer.alloc(1).toString('base64') // 0x00

const kSupportsAckCallback = Symbol('kSupportsAckCallback')

// There MUST NOT exist separate instances of RC clients in a tracer making separate ClientGetConfigsRequest
// with their own separated Client.ClientState.
class RemoteConfigManager {
  #handlers = new Map()
  #products = new Set()
  #batchHandlers = new Map()

  constructor (config) {
    const pollInterval = Math.floor(config.remoteConfig.pollInterval * 1000)

    this.url = config.url || new URL(format({
      protocol: 'http:',
      hostname: config.hostname || defaults.hostname,
      port: config.port
    }))

    tagger.add(config.tags, {
      '_dd.rc.client_id': clientId
    })

    const tags = config.repositoryUrl
      ? {
          ...config.tags,
          [GIT_REPOSITORY_URL]: config.repositoryUrl,
          [GIT_COMMIT_SHA]: config.commitSHA
        }
      : config.tags

    const appliedConfigs = this.appliedConfigs = new Map()

    this.scheduler = new Scheduler((cb) => this.poll(cb), pollInterval)

    this.state = {
      client: {
        state: { // updated by `parseConfig()` and `poll()`
          root_version: 1,
          targets_version: 0,
          // Use getter so `apply_*` can be updated async and still affect the content of `config_states`
          get config_states () {
            const configs = []
            for (const conf of appliedConfigs.values()) {
              configs.push({
                id: conf.id,
                version: conf.version,
                product: conf.product,
                apply_state: conf.apply_state,
                apply_error: conf.apply_error
              })
            }
            return configs
          },
          has_error: false,
          error: '',
          backend_client_state: ''
        },
        id: clientId,
        products: /** @type {string[]} */ ([]), // updated by `updateProducts()`
        is_tracer: true,
        client_tracer: {
          runtime_id: config.tags['runtime-id'],
          language: 'node',
          tracer_version: tracerVersion,
          service: config.service,
          env: config.env,
          app_version: config.version,
          extra_services: /** @type {string[]} */ ([]),
          tags: Object.entries(tags).map((pair) => pair.join(':')),
          [processTags.REMOTE_CONFIG_FIELD_NAME]: processTags.tagsObject
        },
        capabilities: DEFAULT_CAPABILITY // updated by `updateCapabilities()`
      },
      cached_target_files: /** @type {RcCachedTargetFile[]} */ ([]) // updated by `parseConfig()`
    }
  }

  /**
   * @param {bigint} mask
   * @param {boolean} value
   */
  updateCapabilities (mask, value) {
    const hex = Buffer.from(this.state.client.capabilities, 'base64').toString('hex')

    let num = BigInt(`0x${hex}`)

    if (value) {
      num |= mask
    } else {
      num &= ~mask
    }

    let str = num.toString(16)

    if (str.length % 2) str = `0${str}`

    this.state.client.capabilities = Buffer.from(str, 'hex').toString('base64')
  }

  /**
   * Subscribe to a product and register a per-config handler.
   *
   * This is the common API for products that can be handled one config at a time.
   * It **implies subscription** (equivalent to calling `subscribeProducts(product)`).
   *
   * @param {string} product
   * @param {Function} handler
   */
  setProductHandler (product, handler) {
    this.#handlers.set(product, handler)
    this.subscribeProducts(product)
  }

  /**
   * Remove the per-config handler for a product and unsubscribe from it.
   *
   * If you only want to stop receiving configs (but keep the handler attached for later),
   * call `unsubscribeProducts(product)` instead.
   *
   * @param {string} product
   */
  removeProductHandler (product) {
    this.#handlers.delete(product)
    this.unsubscribeProducts(product)
  }

  /**
   * Subscribe to one or more products with Remote Config (receive configs for them).
   *
   * This only affects subscription/polling and does **not** register any handler.
   *
   * @param {...string} products
   */
  subscribeProducts (...products) {
    const hadProducts = this.#products.size > 0
    for (const product of products) {
      this.#products.add(product)
    }
    this.updateProducts()
    if (!hadProducts && this.#products.size > 0) {
      this.scheduler.start()
    }
  }

  /**
   * Unsubscribe from one or more products (stop receiving configs for them).
   *
   * This does **not** remove registered handlers; use `removeProductHandler(product)`
   * if you want to detach a handler as well.
   *
   * @param {...string} products
   */
  unsubscribeProducts (...products) {
    const hadProducts = this.#products.size > 0
    for (const product of products) {
      this.#products.delete(product)
    }
    this.updateProducts()
    if (hadProducts && this.#products.size === 0) {
      this.scheduler.stop()
    }
  }

  updateProducts () {
    this.state.client.products = [...this.#products]
  }

  /**
   * Register a handler that will be invoked once per RC update, with the update batch filtered
   * down to the specified products. This is useful for consumers that need to process multiple
   * configs at once (e.g. WAF updates spanning ASM/ASM_DD/ASM_DATA) and then do one-time reconciliation.
   *
   * This does **not** implicitly subscribe to the products; call `subscribeProducts()` separately.
   *
   * @param {string[]} products
   * @param {(tx: RcBatchUpdateTx) => void} handler
   */
  setBatchHandler (products, handler) {
    this.#batchHandlers.set(handler, new Set(products))
  }

  /**
   * Remove a previously-registered batch handler.
   *
   * @param {Function} handler
   */
  removeBatchHandler (handler) {
    this.#batchHandlers.delete(handler)
  }

  getPayload () {
    this.state.client.client_tracer.extra_services = getExtraServices()

    return JSON.stringify(this.state)
  }

  poll (cb) {
    const options = {
      url: this.url,
      method: 'POST',
      path: '/v0.7/config',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    }

    request(this.getPayload(), options, (err, data, statusCode) => {
      // 404 means RC is disabled, ignore it
      if (statusCode === 404) return cb()

      if (err) {
        log.errorWithoutTelemetry('[RC] Error in request', err)
        return cb()
      }

      // if error was just sent, reset the state
      if (this.state.client.state.has_error) {
        this.state.client.state.has_error = false
        this.state.client.state.error = ''
      }

      if (data && data !== '{}') { // '{}' means the tracer is up to date
        try {
          this.parseConfig(JSON.parse(data))
        } catch (err) {
          log.error('[RC] Could not parse remote config response', err)

          this.state.client.state.has_error = true
          this.state.client.state.error = err.toString()
        }
      }

      cb()
    })
  }

  // `client_configs` is the list of config paths to have applied
  // `targets` is the signed index with metadata for config files
  // `target_files` is the list of config files containing the actual config data
  parseConfig ({
    client_configs: clientConfigs = [],
    targets,
    target_files: targetFiles = []
  }) {
    const toUnapply = /** @type {RcConfigState[]} */ ([])
    const toApply = /** @type {RcConfigState[]} */ ([])
    const toModify = /** @type {RcConfigState[]} */ ([])
    const txByPath = new Map()
    const txHandledPaths = new Set()
    const txOutcomes = new Map()

    for (const appliedConfig of this.appliedConfigs.values()) {
      if (!clientConfigs.includes(appliedConfig.path)) {
        toUnapply.push(appliedConfig)
        txByPath.set(appliedConfig.path, appliedConfig)
      }
    }

    targets = fromBase64JSON(targets)

    if (targets) {
      for (const path of clientConfigs) {
        const meta = targets.signed.targets[path]
        if (!meta) throw new Error(`Unable to find target for path ${path}`)

        const current = this.appliedConfigs.get(path)

        const newConf = /** @type {RcConfigState} */ ({})

        if (current) {
          if (current.hashes.sha256 === meta.hashes.sha256) continue

          toModify.push(newConf)
        } else {
          toApply.push(newConf)
        }

        const file = targetFiles.find(file => file.path === path)
        if (!file) throw new Error(`Unable to find file for path ${path}`)

        // TODO: verify signatures
        //       verify length
        //       verify hash
        //       verify _type
        // TODO: new Date(meta.signed.expires) ignore the Targets data if it has expired ?

        const { product, id } = parseConfigPath(path)

        Object.assign(newConf, {
          path,
          product,
          id,
          version: meta.custom.v,
          apply_state: UNACKNOWLEDGED,
          apply_error: '',
          length: meta.length,
          hashes: meta.hashes,
          file: fromBase64JSON(file.raw)
        })
        txByPath.set(path, newConf)
      }

      this.state.client.state.targets_version = targets.signed.version
      this.state.client.state.backend_client_state = targets.signed.custom.opaque_backend_state
    }

    if (toUnapply.length || toApply.length || toModify.length) {
      const tx = createUpdateTransaction({ toUnapply, toApply, toModify }, txHandledPaths, txOutcomes)

      if (this.#batchHandlers.size) {
        for (const [handler, products] of this.#batchHandlers) {
          const txView = filterTransactionByProducts(tx, products)
          if (txView.toUnapply.length || txView.toApply.length || txView.toModify.length) {
            handler(txView)
          }
        }
      }

      applyOutcomes(txByPath, txOutcomes)

      this.dispatch(toUnapply, 'unapply', txHandledPaths)
      this.dispatch(toApply, 'apply', txHandledPaths)
      this.dispatch(toModify, 'modify', txHandledPaths)

      this.state.cached_target_files = /** @type {RcCachedTargetFile[]} */ ([])

      for (const conf of this.appliedConfigs.values()) {
        const hashes = []
        for (const hash of Object.entries(conf.hashes)) {
          hashes.push({ algorithm: hash[0], hash: hash[1] })
        }
        this.state.cached_target_files.push({
          path: conf.path,
          length: conf.length,
          hashes
        })
      }
    }
  }

  /**
   * Dispatch a list of config changes to per-product handlers, skipping any paths
   * marked as handled by a batch handler.
   *
   * @param {RcConfigState[]} list
   * @param {'apply' | 'modify' | 'unapply'} action
   * @param {Set<string>} handledPaths
   */
  dispatch (list, action, handledPaths) {
    for (const item of list) {
      if (!handledPaths.has(item.path)) {
        this._callHandlerFor(action, item)
      }

      if (action === 'unapply') {
        this.appliedConfigs.delete(item.path)
      } else {
        this.appliedConfigs.set(item.path, item)
      }
    }
  }

  /**
   * @param {'apply' | 'modify' | 'unapply'} action
   * @param {RcConfigState} item
   */
  _callHandlerFor (action, item) {
    // in case the item was already handled by a batch hook
    if (item.apply_state !== UNACKNOWLEDGED && action !== 'unapply') return

    const handler = this.#handlers.get(item.product)

    if (!handler) return

    try {
      if (supportsAckCallback(handler)) {
        // If the handler accepts an `ack` callback, expect that to be called and set `apply_state` accordingly
        // TODO: do we want to pass old and new config ?
        handler(action, item.file, item.id, (err) => {
          if (err) {
            item.apply_state = ERROR
            item.apply_error = err.toString()
          } else if (item.apply_state !== ERROR) {
            item.apply_state = ACKNOWLEDGED
          }
        })
      } else {
        // If the handler doesn't accept an `ack` callback, assume `apply_state` is `ACKNOWLEDGED`,
        // unless it returns a promise, in which case we wait for the promise to be resolved or rejected.
        // TODO: do we want to pass old and new config ?
        const result = handler(action, item.file, item.id)
        if (result instanceof Promise) {
          result.then(
            () => { item.apply_state = ACKNOWLEDGED },
            (err) => {
              item.apply_state = ERROR
              item.apply_error = err.toString()
            }
          )
        } else {
          item.apply_state = ACKNOWLEDGED
        }
      }
    } catch (err) {
      item.apply_state = ERROR
      item.apply_error = err.toString()
    }
  }
}

/**
 * Remote Config “applied config” state tracked by the RC manager.
 * This is the mutable shape stored in `this.appliedConfigs` and passed to per-product handlers.
 *
 * @typedef {Object} RcConfigState
 * @property {string} path
 * @property {string} product
 * @property {string} id
 * @property {number} version
 * @property {unknown} file
 * @property {number} apply_state
 * @property {string} apply_error
 * @property {number} length
 * @property {Record<string, string>} hashes
 */

/**
 * Target file metadata cached in `state.cached_target_files` and sent back to the agent.
 *
 * @typedef {Object} RcCachedTargetFile
 * @property {string} path
 * @property {number} length
 * @property {Array<{algorithm: string, hash: string}>} hashes
 */

/**
 * @typedef {Object} RcConfigDescriptor
 * @property {string} path
 * @property {string} product
 * @property {string} id
 * @property {number} version
 * @property {unknown} file
 */

/**
 * Remote Config batch update transaction passed to batch handlers registered via
 * `RemoteConfigManager.setBatchHandler()`.
 *
 * @typedef {Object} RcBatchUpdateTx
 * @property {RcConfigDescriptor[]} toUnapply
 * @property {RcConfigDescriptor[]} toApply
 * @property {RcConfigDescriptor[]} toModify
 * @property {{toUnapply: RcConfigDescriptor[], toApply: RcConfigDescriptor[], toModify: RcConfigDescriptor[]}} changes
 * @property {(path: string) => void} markHandled
 * @property {(path: string) => void} ack
 * @property {(path: string, err: unknown) => void} error
 */

/**
 * Create an immutable “view” of the batch changes and attach explicit outcome reporting.
 *
 * @param {{toUnapply: RcConfigState[], toApply: RcConfigState[], toModify: RcConfigState[]}} changes
 * @param {Set<string>} handledPaths
 * @param {Map<string, {state: number, error: string}>} outcomes
 * @returns {RcBatchUpdateTx}
 */
function createUpdateTransaction ({ toUnapply, toApply, toModify }, handledPaths, outcomes) {
  const descriptors = {
    toUnapply: toUnapply.map(toDescriptor),
    toApply: toApply.map(toDescriptor),
    toModify: toModify.map(toDescriptor)
  }

  // Expose descriptors directly for ease-of-use, and also under `changes` for clarity.
  const tx = {
    ...descriptors,
    changes: descriptors,
    markHandled (path) {
      if (typeof path !== 'string') return
      handledPaths.add(path)
    },
    ack (path) {
      if (typeof path !== 'string') return
      outcomes.set(path, { state: ACKNOWLEDGED, error: '' })
      handledPaths.add(path)
    },
    error (path, err) {
      if (typeof path !== 'string') return
      outcomes.set(path, { state: ERROR, error: err ? err.toString() : 'Error' })
      handledPaths.add(path)
    }
  }

  return tx
}

/**
 * Create a filtered “view” of the transaction for a given product set, while preserving
 * the outcome methods (ack/error/markHandled).
 *
 * @param {RcBatchUpdateTx} tx
 * @param {Set<string>} products
 * @returns {RcBatchUpdateTx}
 */
function filterTransactionByProducts (tx, products) {
  const toUnapply = []
  const toApply = []
  const toModify = []

  for (const item of tx.toUnapply) {
    if (products.has(item.product)) toUnapply.push(item)
  }

  for (const item of tx.toApply) {
    if (products.has(item.product)) toApply.push(item)
  }

  for (const item of tx.toModify) {
    if (products.has(item.product)) toModify.push(item)
  }

  const changes = { toUnapply, toApply, toModify }

  return {
    toUnapply,
    toApply,
    toModify,
    changes,
    markHandled: tx.markHandled,
    ack: tx.ack,
    error: tx.error
  }
}

/**
 * @param {RcConfigState} conf
 * @returns {RcConfigDescriptor}
 */
function toDescriptor (conf) {
  return {
    path: conf.path,
    product: conf.product,
    id: conf.id,
    version: conf.version,
    file: conf.file
  }
}

function applyOutcomes (byPath, outcomes) {
  for (const [path, outcome] of outcomes) {
    const item = byPath.get(path)
    if (!item) continue
    item.apply_state = outcome.state
    item.apply_error = outcome.error
  }
}

function fromBase64JSON (str) {
  if (!str) return null

  return JSON.parse(Buffer.from(str, 'base64').toString())
}

const configPathRegex = /^(?:datadog\/\d+|employee)\/([^/]+)\/([^/]+)\/[^/]+$/

function parseConfigPath (configPath) {
  const match = configPathRegex.exec(configPath)

  if (!match || !match[1] || !match[2]) {
    throw new Error(`Unable to parse path ${configPath}`)
  }

  return {
    product: match[1],
    id: match[2]
  }
}

function supportsAckCallback (handler) {
  if (kSupportsAckCallback in handler) return handler[kSupportsAckCallback]

  const numOfArgs = handler.length
  let result = false

  if (numOfArgs >= 4) {
    result = true
  } else if (numOfArgs !== 0) {
    const source = handler.toString()
    result = source.slice(0, source.indexOf(')')).includes('...')
  }

  handler[kSupportsAckCallback] = result

  return result
}

module.exports = RemoteConfigManager
