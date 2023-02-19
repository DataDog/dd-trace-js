'use strict'

const waf = require('./waf')
const log = require('../log')

const RULES_OVERRIDE_KEY = 'rules_override'
const EXCLUSIONS_KEY = 'exclusions'
const RULES_DATA_KEY = 'rules_data'

const appliedAsmData = new Map()
let defaultRules, asmDDRules
let rulesOverride
let exclusions

function applyRules (rules, config) {
  if (waf.wafManager) return
  defaultRules = rules
  waf.init(rules, config)
}

function updateAsmDDRules (action, asmRules) {
  if (action === 'unapply') {
    asmDDRules = undefined
  } else {
    asmDDRules = asmRules
  }
  updateAppliedRules()
}

function updateAppliedRules () {
  const rules = { ...(asmDDRules || defaultRules) }
  if (rulesOverride) {
    rules[RULES_OVERRIDE_KEY] = rulesOverride
  }
  if (exclusions) {
    rules[EXCLUSIONS_KEY] = exclusions
  }
  if (appliedAsmData && appliedAsmData.size > 0) {
    rules[RULES_DATA_KEY] = mergeRuleData(appliedAsmData.values())
  }
  try {
    waf.wafManager.update(rules)
  } catch {
    log.error('AppSec could not load native package. Applied rules have not been updated')
  }
}

function updateAsm (action, asm) {
  if (action === 'apply') {
    let rulesObject
    if (asm.hasOwnProperty(RULES_OVERRIDE_KEY)) {
      rulesOverride = asm[RULES_OVERRIDE_KEY]
      rulesObject = { [RULES_OVERRIDE_KEY]: rulesOverride }
      // TODO Should we check if the array is empty?
      // TODO Should we do some merge beteween different applies?
    }
    if (asm.hasOwnProperty(EXCLUSIONS_KEY)) {
      exclusions = asm[EXCLUSIONS_KEY]
      rulesObject = { ...rulesObject, exclusions }
      // TODO Should we check if the array is empty?
      // TODO Should we do some merge beteween different applies?
    }
    if (rulesObject) {
      applyRulesObject(rulesObject)
    }
  }
}

function applyRulesObject (rulesObject) {
  if (rulesObject && waf.wafManager) {
    waf.wafManager.update(rulesObject)
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
  waf.wafManager && waf.wafManager.update({ [RULES_DATA_KEY]: mergedRuleData })
}

function mergeRuleData (asmDataValues) {
  const mergedRulesData = new Map()
  for (const asmData of asmDataValues) {
    if (!asmData[RULES_DATA_KEY]) continue
    for (const rulesData of asmData[RULES_DATA_KEY]) {
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
  waf.destroy()
  appliedAsmData.clear()
  asmDDRules = null
  rulesOverride = null
  exclusions = null
}

module.exports = {
  applyRules,
  clearAllRules,
  updateAsm,
  updateAsmData,
  updateAsmDDRules
}
