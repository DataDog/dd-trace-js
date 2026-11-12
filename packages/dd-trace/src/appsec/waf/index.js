'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const Limiter = require('../../rate_limiter')
const { keepTrace } = require('../../priority_sampler')
const { ASM } = require('../../standalone/product')
const web = require('../../plugins/util/web')
const { getActiveRequest } = require('../store')
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
 * @typedef {import('./waf_manager').WAFManagerConfig & { DD_APPSEC_TRACE_RATE_LIMIT: number }} WAFConfig
 */

const waf = {
  /** @type {WAFManager | null} */
  wafManager: null,
  init,
  destroy,
  updateConfig,
  removeConfig,
  checkAsmDdFallback,
  run: noop,
  runSubContext: noop,
  disposeSubContext,
  getRequest,
  disposeContext: noop,
  WafUpdateError,
}

/**
 * @param {object} rules
 * @param {WAFConfig} config
 */
function init (rules, config) {
  destroy()

  limiter = new Limiter(config.DD_APPSEC_TRACE_RATE_LIMIT)

  // Lazy loading improves the startup time
  WAFManager = require('./waf_manager')

  waf.wafManager = new WAFManager(rules, config)

  waf.runSubContext = runSubContext
  waf.run = run
  waf.disposeContext = disposeContext
}

function destroy () {
  if (waf.wafManager) {
    waf.wafManager.destroy()
    waf.wafManager = null
  }

  waf.runSubContext = noop
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

// `req` in the WAF execution path may be any object, not necessarily
// an HTTP IncomingMessage (it is a plain object for lambda).
// Always guard HTTP-specific property access.
// @see packages/dd-trace/test/appsec/lambda.spec.js

/**
 * @param {object} data - Flat WAF address map
 * @param {object} req - Request key for WAF context lookup. May be an HTTP
 *   IncomingMessage or a plain object (Lambda invocation key).
 * @param {string} [raspRule] - RASP rule identifier
 * @param {object} [rootSpan] - Root span to tag (required for Lambda)
 */
function run (data, req, raspRule, rootSpan) {
  if (!req) {
    req = getActiveRequest()
    if (!req) {
      log.warn('[ASM] Request object not available in waf.run')
      return
    }
  }

  const wafContext = waf.wafManager.getWAFContext(req)
  if (!wafContext) return
  return runContext(data, wafContext, raspRule, rootSpan)
}

/**
 * @param {object} data - Flat WAF address map.
 * @param {import('./waf_context_wrapper')} wafContext - Context selected for this evaluation.
 * @param {object} [raspRule] - RASP rule metadata.
 * @param {object} [rootSpan] - Explicit Lambda root span.
 */
function runContext (data, wafContext, raspRule, rootSpan) {
  const req = wafContext.parent ? wafContext.parent.req : wafContext.req
  const result = wafContext.run(data, raspRule, rootSpan)

  if (result?.keep) {
    if (limiter.isAllowed()) {
      const span = rootSpan || web.root(req)
      keepTrace(span, ASM)
    } else {
      updateRateLimitedMetric(req)
    }
  }

  return result
}

/**
 * @typedef {{ wafSubcontext?: import('./waf_context_wrapper') }} SubcontextState
 */

/**
 * Evaluate an isolated check, or reuse a subcontext across calls carrying the same state.
 * @param {object} data - Flat WAF address map.
 * @param {object} [raspRule] - RASP rule metadata.
 * @param {SubcontextState} [state] - Instrumentation context, released by calling disposeSubContext.
 */
function runSubContext (data, raspRule, state) {
  let subcontext = state?.wafSubcontext
  if (!subcontext) {
    const req = getActiveRequest()
    if (!req) return
    const context = waf.wafManager.getWAFContext(req)
    if (!context) return
    if (context.ddwafContext.disposed) return runContext(data, context, raspRule)
    subcontext = context.createSubcontext()
    if (!subcontext) return
    if (state) state.wafSubcontext = subcontext
  }
  try {
    return runContext(data, subcontext, raspRule)
  } finally {
    if (!state) subcontext.dispose()
  }
}

/** @param {SubcontextState} state - Instrumentation context bound by runSubContext. */
function getRequest (state) {
  return state.wafSubcontext?.parent.req
}

/** @param {SubcontextState} state - Instrumentation context whose evaluation is complete. */
function disposeSubContext (state) {
  const subcontext = state.wafSubcontext
  if (!subcontext) return
  state.wafSubcontext = undefined
  subcontext.dispose()
}

function disposeContext (req) {
  const wafContext = waf.wafManager.getWAFContext(req)

  if (wafContext && !wafContext.ddwafContext.disposed) {
    wafContext.dispose()
  }
}

function noop () {}

module.exports = waf
