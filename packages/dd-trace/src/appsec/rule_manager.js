'use strict'

const fs = require('fs')
const waf = require('./waf')
const { ACKNOWLEDGED, ERROR } = require('../remote_config/apply_states')

const blocking = require('./blocking')

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

  for (const item of toUnapply) {
    if (!['ASM_DD', 'ASM_DATA', 'ASM'].includes(item.product)) continue

    try {
      waf.wafManager.remove(item.path)
    } catch (e) {
      item.apply_state = ERROR
      item.apply_error = e.toString()
    }
  }

  for (const item of [...toApply, ...toModify]) {
    if (!['ASM_DD', 'ASM_DATA', 'ASM'].includes(item.product)) continue

    try {
      const updateResult = waf.wafManager.update(item.product, item.file, item.path)
      item.apply_state = updateResult.success ? ACKNOWLEDGED : ERROR
      item.apply_error = updateResult.error

      // check asm actions
      if (updateResult.success && item.product === 'ASM') {
        if (item.file?.actions?.length) {
          newActions.set(item.id, item.file.actions)
        }
      }

    } catch (e) {
      item.apply_state = ERROR
      item.apply_error = e.toString()
    }
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
