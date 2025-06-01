'use strict'

const fs = require('fs')
const waf = require('./waf')
const { ACKNOWLEDGED, ERROR } = require('../remote_config/apply_states')
const Reporter = require('./reporter')

const blocking = require('./blocking')

const ASM_PRODUCTS = new Set(['ASM', 'ASM_DD', 'ASM_DATA'])

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
  let wafUpdatedSuccess = true

  for (const item of toUnapply) {
    if (!ASM_PRODUCTS.has(item.product)) continue

    try {
      waf.wafManager.remove(item.path)
      item.apply_state = ACKNOWLEDGED
      wafUpdated = true

      if (item.product === 'ASM') {
        newActions.delete(item.id)
      }
    } catch (e) {
      wafUpdatedSuccess = false
      item.apply_state = ERROR
      item.apply_error = e.toString()
      Reporter.reportWafConfigError(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion)
    }
  }

  for (const item of [...toApply, ...toModify]) {
    if (!ASM_PRODUCTS.has(item.product)) continue

    try {
      const updateResult = waf.wafManager.update(item.product, item.file, item.path)
      item.apply_state = updateResult.success ? ACKNOWLEDGED : ERROR

      if (updateResult.success) {
        wafUpdated = true
        Reporter.reportSuccessfulWafUpdate(item.product, item.id, updateResult.diagnostics)
      } else {
        wafUpdatedSuccess = false
        item.apply_error = JSON.stringify(extractErrors(updateResult.diagnostics))
        Reporter.reportWafConfigError(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion)
      }

      // check asm actions
      if (updateResult.success && item.product === 'ASM' && item.file?.actions?.length) {
        newActions.set(item.id, item.file.actions)
      }
    } catch (e) {
      wafUpdatedSuccess = false
      item.apply_state = ERROR
      item.apply_error = e.toString()
      Reporter.reportWafConfigError(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion)
    }
  }

  if (wafUpdated) {
    Reporter.reportWafUpdate(waf.wafManager.ddwafVersion, waf.wafManager.rulesVersion, wafUpdatedSuccess)
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

function extractErrors (obj) {
  if (typeof obj !== 'object' || obj === null) return null

  const result = {}
  let isResultPopulated = false

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'error' || key === 'errors') {
      result[key] = value
      isResultPopulated = true
    } else if (typeof value === 'object' && value !== null) {
      const child = extractErrors(value)
      if (child) {
        isResultPopulated = true
        result[key] = child
      }
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
