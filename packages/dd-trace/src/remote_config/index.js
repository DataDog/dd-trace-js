'use strict'

const uuid = require('../../../../vendor/dist/crypto-randomuuid')
const tracerVersion = require('../../../../package.json').version
const log = require('../log')
const { getExtraServices } = require('../service-naming/extra-services')
const getGitMetadata = require('../git_metadata')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../plugins/util/tags')
const tagger = require('../tagger')
const processTags = require('../process-tags')
const Scheduler = require('./scheduler')
const createFetcher = require('./fetcher')
const capabilityMasks = require('./capabilities')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('./apply_states')

/** @typedef {import('./fetcher').RcChangeRecord} RcChangeRecord */

const clientId = uuid()

const kSupportsAckCallback = Symbol('kSupportsAckCallback')

// Fetchers accept capability names rather than capability integers. We can eventually change the
// actual definition to just use names.
const capabilityNamesByMask = new Map()
for (const [name, mask] of Object.entries(capabilityMasks)) {
  capabilityNamesByMask.set(mask, name)
}

const agentRequestTimeoutMs = 2000
const agentlessRequestTimeoutMs = 5000

// There MUST NOT exist separate instances of RC clients in a tracer making separate
// ClientGetConfigsRequest with their own separated Client.ClientState. The fetcher owns that state;
// this class owns the tracer-facing subscription and handler dispatch on top of it.
class RemoteConfig {
  /** @type {import('./fetcher').RcFetcher | undefined} */
  #fetcher
  #handlers = new Map()
  #products = new Set()
  #capabilities = new Set()
  #batchHandlers = new Map()
  // Products and capabilities are pushed to the native client at the start of the next poll rather
  // than on every mutation: subsystems enable them one at a time while wiring up their handlers.
  #subscriptionsChanged = false

  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  constructor (config) {
    const pollInterval = Math.floor(config.remoteConfig.pollInterval * 1000)

    tagger.add(config.tags, {
      '_dd.rc.client_id': clientId,
    })

    const { commitSHA, repositoryUrl } = getGitMetadata(config)
    const tags = repositoryUrl
      ? {
          ...config.tags,
          [GIT_REPOSITORY_URL]: repositoryUrl,
          [GIT_COMMIT_SHA]: commitSHA,
        }
      : config.tags

    /**
     * Configs the tracer has applied, by path, with their parsed contents retained so that
     * `unapply` handlers receive the config that is going away. This is a *subset* of the
     * fetcher's own active files: a config whose contents failed to parse is tracked there but
     * never lands here.
     *
     * @type {Map<string, RcConfigState>}
     */
    this.appliedConfigs = new Map()

    this.scheduler = new Scheduler((cb) => this.poll(cb), pollInterval)

    try {
      this.#fetcher = createFetcher({
        clientId,
        runtimeId: config.tags['runtime-id'],
        service: config.service,
        env: config.env ?? '',
        appVersion: config.version ?? '',
        tags: Object.entries(tags).map((pair) => pair.join(':')),
        processTags: processTags.tagsArray ?? [],
        language: 'node',
        tracerVersion,
        url: config.DD_AGENTLESS_ENABLED ? `https://${config.site}` : config.url.toString(),
        timeoutMs: config.DD_AGENTLESS_ENABLED ? agentlessRequestTimeoutMs : agentRequestTimeoutMs,
        ...(config.DD_AGENTLESS_ENABLED && {
          agentless: true,
          apiKey: config.DD_API_KEY,
          hostname: config.hostname,
        }),
      })
    } catch (error) {
      log.error('[RC] Could not start the remote config client, remote config is disabled', error)
    }
  }

  /**
   * @param {bigint} mask
   * @param {boolean} value
   */
  updateCapabilities (mask, value) {
    const name = capabilityNamesByMask.get(mask)

    if (name === undefined) {
      log.error('[RC] Ignoring unknown remote config capability 0x%s', mask.toString(16))
      return
    }

    if (this.#capabilities.has(name) === value) return

    if (value) {
      this.#capabilities.add(name)
    } else {
      this.#capabilities.delete(name)
    }

    this.#subscriptionsChanged = true
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
    this.#subscriptionsChanged = true
    if (this.#fetcher !== undefined && !hadProducts && this.#products.size > 0) {
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
    this.#subscriptionsChanged = true
    if (hadProducts && this.#products.size === 0) {
      this.scheduler.stop()
    }
  }

  /**
   * Register a handler that will be invoked once per RC update, with the update batch filtered
   * down to the specified products. This is useful for consumers that need to process multiple
   * configs at once (e.g. WAF updates spanning ASM/ASM_DD/ASM_DATA) and then do one-time reconciliation.
   *
   * This does **not** implicitly subscribe to the products; call `subscribeProducts()` separately.
   *
   * @param {string[]} products
   * @param {(transaction: RcBatchUpdateTransaction) => void} handler
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

  /**
   * @param {() => void} cb - Called once the poll settled, so the scheduler can arm the next one.
   */
  poll (cb) {
    const fetcher = this.#fetcher

    if (fetcher === undefined) return cb()

    // The scheduler hands `poll` straight to `setTimeout`, so anything thrown here would reach the
    // host application as an uncaught exception and take it down with it.
    try {
      if (this.#subscriptionsChanged) {
        const unknown = fetcher.setProductCapabilities([...this.#products], [...this.#capabilities])
        this.#subscriptionsChanged = false

        if (unknown.length !== 0) {
          log.error('[RC] Unrecognized remote config products or capabilities: %s', unknown.join(', '))
        }
      }

      fetcher.setExtraServices(getExtraServices())
    } catch (error) {
      log.error('[RC] Could not update the remote config client', error)
      return cb()
    }

    try {
      fetcher.fetchChanges((error, changes = []) => {
        if (error) {
          log.errorWithoutTelemetry('[RC] Error in request', error)
          cb()
          return
        }

        if (changes.length !== 0) {
          try {
            this.#applyChanges(changes)
          } catch (applyError) {
            log.error('[RC] Could not apply remote config update', applyError)
          }
        }
        cb()
      })
    } catch (error) {
      log.errorWithoutTelemetry('[RC] Error in request', error)
      cb()
    }
  }

  /**
   * Removals always come first, so configs being torn down are unapplied before the configs
   * replacing them are applied.
   *
   * @param {RcChangeRecord[]} changes
   */
  #applyChanges (changes) {
    const toUnapply = /** @type {RcConfigState[]} */ ([])
    const toApply = /** @type {RcConfigState[]} */ ([])
    const toModify = /** @type {RcConfigState[]} */ ([])
    const seenPaths = new Set()
    const transactionOutcomes = new Map()

    for (const change of changes) {
      const { path } = change

      // The native client reports at most one add and one update per path per poll, but it can
      // report both when a config it stored while inactive becomes active with new contents. The
      // second one would dispatch the config to its handler twice.
      if (seenPaths.has(path)) continue
      seenPaths.add(path)

      const current = this.appliedConfigs.get(path)

      if (change.kind === 'remove') {
        // Nothing to unapply for a config the tracer never applied, e.g. one whose contents
        // failed to parse.
        if (current === undefined) continue

        toUnapply.push(current)
        continue
      }

      let file
      try {
        file = parseConfigFile(change.contents)
      } catch (error) {
        log.error('[RC] Could not parse the config file at path %s', path, error)
        this.#fetcher?.setConfigState(path, ERROR, error.toString())
        continue
      }

      const conf = /** @type {RcConfigState} */ ({
        path,
        product: change.product,
        id: change.configId,
        version: change.version,
        apply_state: UNACKNOWLEDGED,
        apply_error: '',
        file,
      })

      // An update of a config the tracer never applied is an apply from the tracer's point of view.
      if (change.kind === 'update' && current !== undefined && current.apply_state !== ERROR) {
        toModify.push(conf)
      } else {
        toApply.push(conf)
      }
    }

    if (toUnapply.length === 0 && toApply.length === 0 && toModify.length === 0) return

    const transaction = createUpdateTransaction({ toUnapply, toApply, toModify }, transactionOutcomes)

    for (const [handler, products] of this.#batchHandlers) {
      const transactionView = filterTransactionByProducts(transaction, products)
      if (transactionView.toUnapply.length || transactionView.toApply.length || transactionView.toModify.length) {
        handler(transactionView)
      }
    }

    this.dispatch(toUnapply, 'unapply', transactionOutcomes)
    this.dispatch(toApply, 'apply', transactionOutcomes)
    this.dispatch(toModify, 'modify', transactionOutcomes)
  }

  /**
   * Dispatch a list of config changes to per-product handlers, skipping any config a batch handler
   * already reported an outcome for.
   *
   * @param {RcConfigState[]} list
   * @param {'apply' | 'modify' | 'unapply'} action
   * @param {Map<string, {state: number, error: string}>} outcomes
   */
  dispatch (list, action, outcomes) {
    for (const item of list) {
      if (action !== 'unapply') {
        this.appliedConfigs.set(item.path, item)
      }

      const outcome = outcomes.get(item.path)
      if (outcome === undefined) {
        this.#callHandlerFor(action, item)
      } else {
        this.#setApplyState(item, outcome.state, outcome.error)
      }

      if (action === 'unapply') {
        this.appliedConfigs.delete(item.path)
      } else {
        // libdatadog's client optimistically reports a stored config as acknowledged, which would
        // hide handlers that acknowledge asynchronously (or not at all) from the backend.
        if (item.apply_state === UNACKNOWLEDGED) {
          this.#fetcher?.setConfigState(item.path, UNACKNOWLEDGED, '')
        }
      }
    }
  }

  /**
   * @param {RcConfigState} item
   * @param {number} applyState
   * @param {string} applyError
   */
  #setApplyState (item, applyState, applyError) {
    if (this.appliedConfigs.get(item.path) !== item) return

    item.apply_state = applyState
    item.apply_error = applyError
    this.#fetcher?.setConfigState(item.path, applyState, applyError)
  }

  /**
   * @param {'apply' | 'modify' | 'unapply'} action
   * @param {RcConfigState} item
   */
  #callHandlerFor (action, item) {
    // in case the item was already handled by a batch hook
    if (item.apply_state !== UNACKNOWLEDGED && action !== 'unapply') return

    const handler = this.#handlers.get(item.product)

    if (!handler) return

    try {
      if (supportsAckCallback(handler)) {
        // If the handler accepts an `ack` callback, expect that to be called and set `apply_state`
        // accordingly
        // TODO: do we want to pass old and new config ?
        handler(action, item.file, item.id, (err) => {
          if (err) {
            this.#setApplyState(item, ERROR, err.toString())
          } else if (item.apply_state !== ERROR) {
            this.#setApplyState(item, ACKNOWLEDGED, '')
          }
        })
      } else {
        // If the handler doesn't accept an `ack` callback, assume `apply_state` is `ACKNOWLEDGED`,
        // unless it returns a promise, in which case we wait for the promise to be resolved or rejected.
        // TODO: do we want to pass old and new config ?
        const result = handler(action, item.file, item.id)
        if (typeof result?.then === 'function') {
          result.then(
            () => this.#setApplyState(item, ACKNOWLEDGED, ''),
            (err) => this.#setApplyState(item, ERROR, err.toString())
          )
        } else {
          this.#setApplyState(item, ACKNOWLEDGED, '')
        }
      }
    } catch (err) {
      this.#setApplyState(item, ERROR, err.toString())
    }
  }
}

/**
 * Remote Config “applied config” state tracked by the RC manager.
 * This is the mutable shape stored in `this.appliedConfigs` and passed to per-product handlers.
 *
 * @typedef {object} RcConfigState
 * @property {string} path
 * @property {string} product
 * @property {string} id
 * @property {number} version
 * @property {unknown} file
 * @property {number} apply_state
 * @property {string} apply_error
 */

/**
 * Remote Config batch update transaction passed to batch handlers registered via
 * `RemoteConfig.setBatchHandler()`.
 *
 * @typedef {object} RcBatchUpdateTransaction
 * @property {RcConfigState[]} toUnapply
 * @property {RcConfigState[]} toApply
 * @property {RcConfigState[]} toModify
 * @property {(path: string) => void} ack
 * @property {(path: string, err: unknown) => void} error
 */

/**
 * Create an immutable "view" of the batch changes and attach explicit outcome reporting. Recording
 * an outcome is also what marks a config as handled, so `dispatch` skips its per-product handler.
 *
 * @param {{toUnapply: RcConfigState[], toApply: RcConfigState[], toModify: RcConfigState[]}} changes
 * @param {Map<string, {state: number, error: string}>} outcomes
 * @returns {RcBatchUpdateTransaction}
 */
function createUpdateTransaction ({ toUnapply, toApply, toModify }, outcomes) {
  return {
    toUnapply,
    toApply,
    toModify,
    ack (path) {
      outcomes.set(path, { state: ACKNOWLEDGED, error: '' })
    },
    error (path, err) {
      outcomes.set(path, { state: ERROR, error: err ? err.toString() : 'Error' })
    },
  }
}

/**
 * Create a filtered "view" of the transaction for a given product set, while preserving
 * the outcome methods (ack/error).
 *
 * @param {RcBatchUpdateTransaction} transaction
 * @param {Set<string>} products
 * @returns {RcBatchUpdateTransaction}
 */
function filterTransactionByProducts (transaction, products) {
  const toUnapply = []
  const toApply = []
  const toModify = []

  for (const item of transaction.toUnapply) {
    if (products.has(item.product)) toUnapply.push(item)
  }

  for (const item of transaction.toApply) {
    if (products.has(item.product)) toApply.push(item)
  }

  for (const item of transaction.toModify) {
    if (products.has(item.product)) toModify.push(item)
  }

  return {
    toUnapply,
    toApply,
    toModify,
    ack: transaction.ack,
    error: transaction.error,
  }
}

/**
 * @param {string | undefined} contents
 * @returns {unknown}
 */
function parseConfigFile (contents) {
  if (contents === undefined) throw new Error('Missing config contents')

  return contents === '' ? null : JSON.parse(contents)
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

module.exports = RemoteConfig
