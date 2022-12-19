'use strict'

const callbacks = require('./callbacks')
const Gateway = require('./gateway/engine')

const appliedCallbacks = new Map()
const appliedAsmData = new Map()

function applyRules (rules, config) {
  if (appliedCallbacks.has(rules)) return

  // for now there is only WAF
  const callback = new callbacks.DDWAF(rules, config)

  appliedCallbacks.set(rules, callback)
}

function updateAsmData (action, asmData, asmDataId) {
  if (action === 'unapply') {
    appliedAsmData.delete(asmDataId)
  } else {
    appliedAsmData.set(asmDataId, asmData)
  }

  const mergedRuleData = mergeRuleData(appliedAsmData.values())
  for (const callback of appliedCallbacks.values()) {
    callback.updateRuleData(mergedRuleData)
  }
}

function mergeRuleData (asmDataValues) {
  const mergedRulesData = new Map()
  for (const asmData of asmDataValues) {
    if (!asmData.rules_data) continue
    for (const rulesData of asmData.rules_data) {
      const key = `${rulesData.id}+${rulesData.type}`
      if (mergedRulesData.has(key)) {
        const existingRulesData = mergedRulesData.get(key)
        rulesData.data.reduce(rulesReducer, existingRulesData.data)
      } else {
        mergedRulesData.set(key, copyRulesData(rulesData))
      }
    }
  }
  return [...mergedRulesData.values()]
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
  Gateway.manager.clear()

  for (const [key, callback] of appliedCallbacks) {
    callback.clear()

    appliedCallbacks.delete(key)
  }
  appliedAsmData.clear()
}

module.exports = {
  applyRules,
  clearAllRules,
  updateAsmData
}
