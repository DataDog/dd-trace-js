'use strict'

const waf = require('./waf')
const { ACKNOWLEDGED, ERROR } = require('./remote_config/apply_states')
const blocking = require('./blocking')

let defaultRules

let appliedRulesData = new Map()
let appliedRulesetId
let appliedRulesOverride = new Map()
let appliedExclusions = new Map()
let appliedCustomRules = new Map()
let appliedActions = new Map()

function applyRules (rules, config) {
  defaultRules = rules

  waf.init(rules, config)

  if (rules.actions) {
    blocking.updateBlockingConfiguration(rules.actions.find(action => action.id === 'block'))
  }
}

function updateWafFromRC ({ toUnapply, toApply, toModify }) {
  const batch = new Set()

  const newRulesData = new SpyMap(appliedRulesData)
  let newRuleset
  let newRulesetId
  const newRulesOverride = new SpyMap(appliedRulesOverride)
  const newExclusions = new SpyMap(appliedExclusions)
  const newCustomRules = new SpyMap(appliedCustomRules)
  const newActions = new SpyMap(appliedActions)

  for (const item of toUnapply) {
    const { product, id } = item

    if (product === 'ASM_DATA') {
      newRulesData.delete(id)
    } else if (product === 'ASM_DD') {
      if (appliedRulesetId === id) {
        newRuleset = defaultRules
      }
    } else if (product === 'ASM') {
      newRulesOverride.delete(id)
      newExclusions.delete(id)
      newCustomRules.delete(id)
      newActions.delete(id)
    }
  }

  for (const item of [...toApply, ...toModify]) {
    const { product, id, file } = item

    if (product === 'ASM_DATA') {
      if (file && file.rules_data && file.rules_data.length) {
        newRulesData.set(id, file.rules_data)
      }

      batch.add(item)
    } else if (product === 'ASM_DD') {
      if (appliedRulesetId && appliedRulesetId !== id && newRuleset !== defaultRules) {
        item.apply_state = ERROR
        item.apply_error = 'Multiple ruleset received in ASM_DD'
      } else {
        if (file && file.rules && file.rules.length) {
          const { version, metadata, rules } = file

          newRuleset = { version, metadata, rules }
          newRulesetId = id
        }

        batch.add(item)
      }
    } else if (product === 'ASM') {
      let batchConfiguration = false
      if (file && file.rules_override && file.rules_override.length) {
        batchConfiguration = true
        newRulesOverride.set(id, file.rules_override)
      }

      if (file && file.exclusions && file.exclusions.length) {
        batchConfiguration = true
        newExclusions.set(id, file.exclusions)
      }

      if (file && file.custom_rules && file.custom_rules.length) {
        batchConfiguration = true
        newCustomRules.set(id, file.custom_rules)
      }

      if (file && file.actions && file.actions.length) {
        newActions.set(id, file.actions)
      }

      // "actions" data is managed by tracer and not by waf
      if (batchConfiguration) {
        batch.add(item)
      }
    }
  }

  let newApplyState = ACKNOWLEDGED
  let newApplyError

  if (newRulesData.modified ||
    newRuleset ||
    newRulesOverride.modified ||
    newExclusions.modified ||
    newCustomRules.modified) {
    const payload = newRuleset || {}

    if (newRulesData.modified) {
      payload.rules_data = mergeRulesData(newRulesData)
    }
    if (newRulesOverride.modified) {
      payload.rules_override = concatArrays(newRulesOverride)
    }
    if (newExclusions.modified) {
      payload.exclusions = concatArrays(newExclusions)
    }
    if (newCustomRules.modified) {
      payload.custom_rules = concatArrays(newCustomRules)
    }

    try {
      waf.update(payload)

      if (newRulesData.modified) {
        appliedRulesData = newRulesData
      }
      if (newRuleset) {
        appliedRulesetId = newRulesetId
      }
      if (newRulesOverride.modified) {
        appliedRulesOverride = newRulesOverride
      }
      if (newExclusions.modified) {
        appliedExclusions = newExclusions
      }
      if (newCustomRules.modified) {
        appliedCustomRules = newCustomRules
      }
    } catch (err) {
      newApplyState = ERROR
      newApplyError = err.toString()
    }
  }

  for (const config of batch) {
    config.apply_state = newApplyState
    if (newApplyError) config.apply_error = newApplyError
  }

  if (newActions.modified) {
    blocking.updateBlockingConfiguration(concatArrays(newActions).find(action => action.id === 'block'))
    appliedActions = newActions
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
  return Array.from(files.values()).flat()
}

/*
  ASM_DATA Merge strategy:
  The merge should be based on the id and type. For any duplicate items, the longer expiration should be taken.
  As a result, multiple Rule Data may use the same DATA_ID and DATA_TYPE. In this case, all values are considered part
  of a set and are merged. For instance, a denylist customized by environment may use a global Rule Data for all
  environments and a Rule Data per environment
*/

function mergeRulesData (files) {
  const mergedRulesData = new Map()
  for (const [, file] of files) {
    for (const ruleData of file) {
      const key = `${ruleData.id}+${ruleData.type}`
      if (mergedRulesData.has(key)) {
        const existingRulesData = mergedRulesData.get(key)
        ruleData.data.reduce(rulesReducer, existingRulesData.data)
      } else {
        mergedRulesData.set(key, copyRulesData(ruleData))
      }
    }
  }
  return Array.from(mergedRulesData.values())
}

function rulesReducer (existingEntries, rulesDataEntry) {
  const existingEntry = existingEntries.find((entry) => entry.value === rulesDataEntry.value)
  if (existingEntry && !('expiration' in existingEntry)) return existingEntries
  if (existingEntry && 'expiration' in rulesDataEntry && rulesDataEntry.expiration > existingEntry.expiration) {
    existingEntry.expiration = rulesDataEntry.expiration
  } else if (existingEntry && !('expiration' in rulesDataEntry)) {
    delete existingEntry.expiration
  } else if (!existingEntry) {
    existingEntries.push({ ...rulesDataEntry })
  }
  return existingEntries
}

function copyRulesData (rulesData) {
  const copy = { ...rulesData }
  if (copy.data) {
    const data = []
    copy.data.forEach(item => {
      data.push({ ...item })
    })
    copy.data = data
  }
  return copy
}

function clearAllRules () {
  waf.destroy()
  blocking.updateBlockingConfiguration(undefined)

  defaultRules = undefined

  appliedRulesData.clear()
  appliedRulesetId = undefined
  appliedRulesOverride.clear()
  appliedExclusions.clear()
  appliedCustomRules.clear()
  appliedActions.clear()
}

module.exports = {
  applyRules,
  updateWafFromRC,
  clearAllRules
}
