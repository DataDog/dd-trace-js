'use strict'

const { readFileSync } = require('node:fs')

const waf = require('./waf')
const { DIAGNOSTIC_KEYS } = require('./waf/diagnostics')
const blocking = require('./blocking')
const Reporter = require('./reporter')
const { ASM_WAF_PRODUCTS_SET } = require('./rc-products')

/*
  ASM Actions must be tracked in order to update the defaultBlockingActions in blocking. These actions are used
  by blockRequest method exposed in the user blocking SDK (see packages/dd-trace/src/appsec/sdk/user_blocking.js)
 */
let appliedActions = new Map()

/**
 * @typedef {object} AsmConfigFile
 * @property {Array<Record<string, any>>} [actions]
 */

/**
 * @typedef {import('./waf').WAFConfig & { rules?: string }} AppSecConfig
 */

/**
 * @param {AppSecConfig} config
 */
function loadRules (config) {
  const defaultRules = config.rules
    ? JSON.parse(readFileSync(config.rules, 'utf8'))
    : require('./recommended.json')

  waf.init(defaultRules, config)

  blocking.setDefaultBlockingActionParameters(defaultRules?.actions)
}

/**
 * Apply ASM remote-config updates to the WAF in a single batch.
 *
 * @param {import('../remote_config/manager').RcBatchUpdateTransaction} transaction
 */
function updateWafFromRC (transaction) {
  const { toUnapply, toApply, toModify } = transaction

  const newActions = new SpyMap(appliedActions)

  let wafUpdated = false
  let wafUpdatedFailed = false

  for (const item of toUnapply) {
    if (!ASM_WAF_PRODUCTS_SET.has(item.product)) continue

    try {
      waf.removeConfig(item.path)

      transaction.ack(item.path)
      wafUpdated = true

      // ASM actions
      if (item.product === 'ASM') {
        newActions.delete(item.id)
      }
    } catch (e) {
      transaction.error(item.path, e)
      wafUpdatedFailed = true
    }
  }

  for (const item of [...toApply, ...toModify]) {
    if (!ASM_WAF_PRODUCTS_SET.has(item.product)) continue

    try {
      waf.updateConfig(item.product, item.id, item.path, item.file)

      transaction.ack(item.path)
      wafUpdated = true

      // ASM actions
      if (item.product === 'ASM') {
        const asmFile = /** @type {AsmConfigFile} */ (item.file)
        if (asmFile?.actions?.length) {
          newActions.set(item.id, asmFile.actions)
        }
      }
    } catch (e) {
      const error = e instanceof waf.WafUpdateError ? JSON.stringify(extractErrors(e.diagnosticErrors)) : e
      transaction.error(item.path, error)
      wafUpdatedFailed = true
    }
  }

  waf.checkAsmDdFallback()

  if (wafUpdated && waf.wafManager) {
    Reporter.reportWafUpdate(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion, !wafUpdatedFailed)
  }

  // Manage blocking actions
  if (newActions.modified) {
    appliedActions = newActions
    blocking.setDefaultBlockingActionParameters(concatArrays(newActions))
  }
}

// A Map with a new prop `modified`, a bool that indicates if the Map was modified
class SpyMap extends Map {
  constructor (iterable) {
    super(iterable)
    this.modified = false
  }

  set (key, value) {
    this.modified = true
    return super.set(key, value)
  }

  delete (key) {
    const result = super.delete(key)
    if (result) this.modified = true
    return result
  }

  clear () {
    this.modified = false
    return super.clear()
  }
}

function concatArrays (files) {
  return [...files.values()].flat()
}

function extractErrors (diagnostics) {
  if (!diagnostics) return

  if (diagnostics.error) return diagnostics

  const result = {}
  let isResultPopulated = false

  for (const diagnosticKey of DIAGNOSTIC_KEYS) {
    if (diagnostics[diagnosticKey]?.error) {
      (result[diagnosticKey] ??= {}).error = diagnostics[diagnosticKey]?.error
      isResultPopulated = true
    }

    if (diagnostics[diagnosticKey]?.errors) {
      (result[diagnosticKey] ??= {}).errors = diagnostics[diagnosticKey]?.errors
      isResultPopulated = true
    }
  }

  return isResultPopulated ? result : null
}

function clearAllRules () {
  waf.destroy()
  appliedActions.clear()
  blocking.setDefaultBlockingActionParameters(undefined)
}

module.exports = {
  loadRules,
  updateWafFromRC,
  clearAllRules
}
