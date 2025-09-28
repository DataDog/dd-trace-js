'use strict'

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const Reporter = require('../reporter')
const Limiter = require('../../rate_limiter')
const { keepTrace } = require('../../priority_sampler')
const { ASM } = require('../../standalone/product')
const web = require('../../plugins/util/web')
const { updateRateLimitedMetric } = require('../telemetry')

/**
 * Types for WAF public API.
 *
 * @typedef {import('http').IncomingMessage} IncomingMessage
 * @typedef {import('./waf_manager')} WAFManagerCtor
 * @typedef {import('./waf_manager')} WAFManagerInstance
 * @typedef {import('./waf_manager').WafConfig} WafConfig
 *
 * @typedef {{
 *   persistent?: Record<string, unknown> | null,
 *   ephemeral?: Record<string, unknown> | null
 * }} WafRunPayload
 *
 * @typedef {{ keep?: boolean } & Record<string, unknown>} WafRunResult
 *
 * @typedef {{
 *   wafManager: WAFManagerInstance | null,
 *   init: (rules: object, config: WafConfig) => void,
 *   destroy: () => void,
 *   updateConfig: (product: string, configId: string, configPath: string, config: object) => void,
 *   removeConfig: (configPath: string) => void,
 *   checkAsmDdFallback: () => void,
 *   run: (data: WafRunPayload, req?: IncomingMessage, raspRule?: string) => WafRunResult | void,
 *   disposeContext: (req: IncomingMessage) => void,
 *   WafUpdateError: typeof WafUpdateError
 * }} WafAPI
 */

class WafUpdateError extends Error {
  /**
   * @param {object} diagnosticErrors
   */
  constructor (diagnosticErrors) {
    super('WafUpdateError')
    this.name = 'WafUpdateError'
    this.diagnosticErrors = diagnosticErrors
  }
}

let limiter = new Limiter(100)

/** @type {Partial<WafAPI>} */
const waf = {
  wafManager: null,
  init,
  destroy,
  updateConfig,
  removeConfig,
  checkAsmDdFallback,
  run: /** @type {WafAPI['run']} */ noop,
  disposeContext: /** @type {WafAPI['disposeContext']} */ noop,
  WafUpdateError
}

/**
 * Initialize the WAF with provided rules and configuration.
 *
 * @param {object} rules
 * @param {WafConfig} config
 * @returns {void}
 */
function init (rules, config) {
  destroy()

  limiter = new Limiter(config.rateLimit)

  // dirty require to make startup faster for serverless
  const WAFManager = require('./waf_manager')

  waf.wafManager = new WAFManager(rules, config)

  /** @type {WafAPI['run']} */
  waf.run = run
  /** @type {WafAPI['disposeContext']} */
  waf.disposeContext = disposeContext
}

/** @returns {void} */
function destroy () {
  if (waf.wafManager) {
    waf.wafManager.destroy()
    waf.wafManager = null
  }

  waf.run = noop
  waf.disposeContext = noop
}

function checkAsmDdFallback () {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    waf.wafManager.setAsmDdFallbackConfig()
  } catch {
    log.error('[ASM] Could not apply default ruleset back as fallback')
  }
}

/**
 * @param {string} product
 * @param {string} configId
 * @param {string} configPath
 * @param {object} config
 * @returns {void}
 */
function updateConfig (product, configId, configPath, config) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    const wm = /** @type {import('./waf_manager')} */ (waf.wafManager)
    if (product === 'ASM_DD') {
      // defaultWafConfigPath is a static on the WAFManager class
      wm.removeConfig(wm.constructor.defaultWafConfigPath)
    }

    const updateSucceeded = wm.updateConfig(configPath, config)
    Reporter.reportWafConfigUpdate(product, configId, wm.ddwaf.diagnostics, wm.ddwafVersion)

    if (!updateSucceeded) {
      throw new WafUpdateError(wm.ddwaf.diagnostics)
    }
  } catch (err) {
    log.error('[ASM] Could not update config from RC')
    throw err
  }
}

/**
 * @param {string} configPath
 * @returns {void}
 */
function removeConfig (configPath) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    const wm = /** @type {import('./waf_manager')} */ (waf.wafManager)
    wm.removeConfig(configPath)
  } catch (err) {
    log.error('[ASM] Could not remove config from RC')
    throw err
  }
}

/**
 * Execute the WAF for the given payload and request.
 *
 * When no request is provided, attempts to use the current store's `req`.
 * If the result indicates the trace should be kept (result.keep), applies ASM sampling behavior.
 *
 * @param {WafRunPayload} data
 * @param {IncomingMessage=} req
 * @param {string=} raspRule
 * @returns {WafRunResult | undefined}
 */
function run (data, req, raspRule) {
  if (!req) {
    const store = storage('legacy').getStore()
    if (!store || !store.req) {
      log.warn('[ASM] Request object not available in waf.run')
      return
    }

    req = store.req
  }

  const wafContext = /** @type {import('./waf_manager')} */ (waf.wafManager).getWAFContext(req)
  const result = wafContext.run(data, raspRule)

  if (result?.keep) {
    if (limiter.isAllowed()) {
      const rootSpan = web.root(req)
      keepTrace(rootSpan, ASM)
    } else {
      updateRateLimitedMetric(req)
    }
  }

  return result
}

/**
 * Dispose the WAF context for the given request.
 *
 * @param {IncomingMessage} req
 * @returns {void}
 */
function disposeContext (req) {
  const wafContext = /** @type {import('./waf_manager')} */ (waf.wafManager).getWAFContext(req)

  if (wafContext && !wafContext.ddwafContext.disposed) {
    wafContext.dispose()
  }
}

function noop () {}

module.exports = waf
