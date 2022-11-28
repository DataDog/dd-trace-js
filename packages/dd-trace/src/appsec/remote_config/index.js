'use strict'

const RemoteConfigManager = require('./manager')
const RemoteConfigCapabilities = require('./capabilities')
const RuleManager = require('../rule_manager')

let rc

function enable (config) {
  rc = new RemoteConfigManager(config)

  if (config.appsec.enabled === undefined) { // only activate ASM_FEATURES when conf is not set locally
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_ACTIVATION, true)

    rc.on('ASM_FEATURES', (action, conf) => {
      if (conf && conf.asm && typeof conf.asm.enabled === 'boolean') {
        let shouldEnable

        if (action === 'apply' || action === 'modify') {
          shouldEnable = conf.asm.enabled // take control
        } else {
          shouldEnable = config.appsec.enabled // give back control to local config
        }

        if (shouldEnable) {
          require('..').enable(config)
        } else {
          require('..').disable()
        }
      }
    })
  }
}

function enableAsmData () {
  rc.on('ASM_DATA', _asmDataListener)
}

function disableAsmData () {
  rc.off('ASM_DATA', _asmDataListener)
}

function _asmDataListener (_, ruleData) {
  RuleManager.updateRuleData(ruleData)
}

module.exports = {
  enable,
  enableAsmData,
  disableAsmData
}
