'use strict'

const WAFManagerModule = require('./waf_manager')
const log = require('../log')

const appliedAsmData = new Map()
let defaultRules
let asmDDRules

function applyRules (rules, config) {
  if (WAFManagerModule.wafManager) return
  defaultRules = rules
  WAFManagerModule.init(rules, config)
}

function updateAsmDDRules (action, asmRules) {
  if (action === 'unapply') {
    asmDDRules = undefined
  } else {
    asmDDRules = asmRules
  }
  updateAppliedRules()
  updateAppliedRuleData()
}

function updateAppliedRules () {
  const rules = asmDDRules || defaultRules
  try {
    WAFManagerModule.wafManager.reload(rules)
  } catch {
    log.error('AppSec could not load native package. Applied rules have not been updated')
  }
}

function updateAsmData (action, asmData, asmDataId) {
  if (action === 'unapply') {
    appliedAsmData.delete(asmDataId)
  } else {
    appliedAsmData.set(asmDataId, asmData)
  }

  updateAppliedRuleData()
}

function updateAppliedRuleData () {
  const mergedRuleData = mergeRuleData(appliedAsmData.values())
  WAFManagerModule.wafManager && WAFManagerModule.wafManager.updateRuleData(mergedRuleData)
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
  WAFManagerModule.destroy()
  appliedAsmData.clear()
}

module.exports = {
  applyRules,
  clearAllRules,
  updateAsmData,
  updateAsmDDRules
}
