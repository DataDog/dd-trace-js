'use strict'

const fs = require('fs')
const waf = require('./waf')
const { DIAGNOSTIC_KEYS } = require('./waf/diagnostics')
const { ACKNOWLEDGED, ERROR } = require('../remote_config/apply_states')
const Reporter = require('./reporter')

const blocking = require('./blocking')

const ASM_PRODUCTS = new Set(['ASM', 'ASM_DD', 'ASM_DATA'])

/*
  ASM Actions must be tracked in order to update the defaultBlockingActions in blocking. These actions are used
  by blockRequest method exposed in the user blocking SDK (see packages/dd-trace/src/appsec/sdk/user_blocking.js)
 */
let appliedActions = new Map()

function loadRules (config) {
  const defaultRules = config.rules
    ? JSON.parse(fs.readFileSync(config.rules))
    : require('./recommended.json')

  waf.init(defaultRules, config)

  blocking.setDefaultBlockingActionParameters(defaultRules?.actions)
}

function updateWafFromRC ({ toUnapply, toApply, toModify }) {
  const newActions = new SpyMap(appliedActions)

  let wafUpdated = false
  let wafUpdatedFailed = false

  for (const item of toUnapply) {
    if (!ASM_PRODUCTS.has(item.product)) continue

    try {
      waf.removeConfig(item.path)

      item.apply_state = ACKNOWLEDGED
      wafUpdated = true

      // ASM actions
      if (item.product === 'ASM') {
        newActions.delete(item.id)
      }
    } catch (e) {
      item.apply_state = ERROR
      item.apply_error = e.toString()
      wafUpdatedFailed = true
    }
  }

  for (const item of [...toApply, ...toModify]) {
    if (!ASM_PRODUCTS.has(item.product)) continue

    try {
      waf.updateConfig(item.product, item.id, item.path, item.file)

      item.apply_state = ACKNOWLEDGED
      wafUpdated = true

      // ASM actions
      if (item.product === 'ASM' && item.file?.actions?.length) {
        newActions.set(item.id, item.file.actions)
      }
    } catch (e) {
      item.apply_state = ERROR
      item.apply_error = e instanceof waf.WafUpdateError
        ? JSON.stringify(extractErrors(e.diagnosticErrors))
        : e.toString()
      wafUpdatedFailed = true
    }
  }

  waf.checkAsmDdFallback()

  if (wafUpdated) {
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
