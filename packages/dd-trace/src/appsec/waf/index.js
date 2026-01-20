'use strict'

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const Reporter = require('../reporter')
const Limiter = require('../../rate_limiter')
const { keepTrace } = require('../../priority_sampler')
const { ASM } = require('../../standalone/product')
const web = require('../../plugins/util/web')
const { updateRateLimitedMetric } = require('../telemetry')

class WafUpdateError extends Error {
  constructor (diagnosticErrors) {
    super('WafUpdateError')
    this.name = 'WafUpdateError'
    this.diagnosticErrors = diagnosticErrors
  }
}

let limiter = new Limiter(100)

/** @typedef {import('./waf_manager')} WAFManager */

/** @type {typeof import('./waf_manager') | null} */
let WAFManager = null

/**
 * @typedef {import('./waf_manager').WAFManagerConfig & { rateLimit: number }} WAFConfig
 */

/**
 * Minimal shape used throughout AppSec/RASP.
 * @typedef {{
 *   actions?: unknown,
 *   events?: unknown,
 *   attributes?: unknown,
 *   keep?: boolean
 * }} WafRunResult
 */

const waf = {
  /** @type {WAFManager | null} */
  wafManager: null,
  init,
  destroy,
  updateConfig,
  removeConfig,
  checkAsmDdFallback,
  run: noopRun,
  disposeContext: noopDispose,
  WafUpdateError
}

/**
 * @param {object} rules
 * @param {WAFConfig} config
 */
function init (rules, config) {
  destroy()

  limiter = new Limiter(config.rateLimit)

  // Lazy loading improves the startup time
  WAFManager = require('./waf_manager')

  waf.wafManager = new WAFManager(rules, config)

  waf.run = run
  waf.disposeContext = disposeContext
}

function destroy () {
  if (waf.wafManager) {
    waf.wafManager.destroy()
    waf.wafManager = null
  }

  waf.run = noopRun
  waf.disposeContext = noopDispose
}

function checkAsmDdFallback () {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    waf.wafManager.setAsmDdFallbackConfig()
  } catch {
    log.error('[ASM] Could not apply default ruleset back as fallback')
  }
}

function updateConfig (product, configId, configPath, config) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    if (product === 'ASM_DD') {
      waf.wafManager.removeConfig((/** @type {NonNullable<typeof WAFManager>} */ (WAFManager)).defaultWafConfigPath)
    }

    const updateSucceeded = waf.wafManager.updateConfig(configPath, config)
    Reporter.reportWafConfigUpdate(product, configId, waf.wafManager.ddwaf.diagnostics, waf.wafManager.ddwafVersion)

    if (!updateSucceeded) {
      throw new WafUpdateError(waf.wafManager.ddwaf.diagnostics)
    }
  } catch (err) {
    log.error('[ASM] Could not update config from RC')
    throw err
  }
}

function removeConfig (configPath) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    waf.wafManager.removeConfig(configPath)
  } catch (err) {
    log.error('[ASM] Could not remove config from RC')
    throw err
  }
}

/**
 * @param {object} data
 * @param {object} [req]
 * @param {object} [raspRule]
 * @returns {WafRunResult | undefined}
 */
function run (data, req, raspRule) {
  if (!waf.wafManager) return

  if (!req) {
    const store = storage('legacy').getStore()
    req = getValue(store && store.req)

    if (!req) {
      log.warn('[ASM] Request object not available in waf.run')
      return
    }
  }

  const wafContext = waf.wafManager.getWAFContext(req)
  const result = /** @type {WafRunResult | undefined} */ (wafContext.run(data, raspRule))

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

function getValue (maybeWeakRef) {
  return maybeWeakRef && typeof maybeWeakRef.deref === 'function' ? maybeWeakRef.deref() : maybeWeakRef
}

function disposeContext (req) {
  if (!waf.wafManager) return

  const wafContext = waf.wafManager.getWAFContext(req)

  if (wafContext && !wafContext.ddwafContext.disposed) {
    wafContext.dispose()
  }
}

/**
 * @returns {WafRunResult | undefined}
 */
function noopRun (..._args) {
  return /** @type {WafRunResult} */ ({})
}

function noopDispose (..._args) {}

module.exports = waf
