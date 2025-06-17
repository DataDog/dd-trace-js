'use strict'

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const Reporter = require('../reporter')

class WafUpdateError extends Error {
  constructor (diagnosticErrors) {
    super('WafUpdateError')
    this.name = 'WafUpdateError'
    this.diagnosticErrors = diagnosticErrors
  }
}

const waf = {
  wafManager: null,
  init,
  destroy,
  updateAsmDdConfig,
  updateConfig,
  removeConfig,
  run: noop,
  disposeContext: noop,
  WafUpdateError
}

function init (rules, config) {
  destroy()

  // dirty require to make startup faster for serverless
  const WAFManager = require('./waf_manager')

  waf.wafManager = new WAFManager(rules, config)

  waf.run = run
  waf.disposeContext = disposeContext
}

function destroy () {
  if (waf.wafManager) {
    waf.wafManager.destroy()
    waf.wafManager = null
  }

  waf.run = noop
  waf.disposeContext = noop
}

function updateAsmDdConfig (configPath, asmDdConfig) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    waf.wafManager.removeConfig(waf.wafManager.constructor.defaultWafConfigPath)
    if (waf.wafManager.updateConfig(configPath, asmDdConfig)) {
      return waf.wafManager.ddwaf.diagnostics
    } else {
      waf.wafManager.setAsmDdFallbackConfig()
      throw new WafUpdateError(waf.wafManager.ddwaf.diagnostics)
    }
  } catch (err) {
    Reporter.reportWafConfigError(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion)
    log.error('[ASM] Could not update ASM DD config from RC')
    throw err
  }
}

function updateConfig (configPath, config) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    if (waf.wafManager.updateConfig(configPath, config)) {
      return waf.wafManager.ddwaf.diagnostics
    } else {
      waf.wafManager.setAsmDdFallbackConfig()
      throw new WafUpdateError(waf.wafManager.ddwaf.diagnostics)
    }
  } catch (err) {
    Reporter.reportWafConfigError(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion)
    log.error('[ASM] Could not update config from RC')
    throw err
  }
}

function removeConfig (configPath) {
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    waf.wafManager.removeConfig(configPath)
    waf.wafManager.setAsmDdFallbackConfig()
  } catch (err) {
    Reporter.reportWafConfigError(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion)
    log.error('[ASM] Could not remove config from RC')
    throw err
  }
}

function run (data, req, raspRule) {
  if (!req) {
    const store = storage('legacy').getStore()
    if (!store || !store.req) {
      log.warn('[ASM] Request object not available in waf.run')
      return
    }

    req = store.req
  }

  const wafContext = waf.wafManager.getWAFContext(req)

  return wafContext.run(data, raspRule)
}

function disposeContext (req) {
  const wafContext = waf.wafManager.getWAFContext(req)

  if (wafContext && !wafContext.ddwafContext.disposed) {
    wafContext.dispose()
  }
}

function noop () {}

module.exports = waf
