'use strict'

const RemoteConfigManager = require('./manager')
const RemoteConfigCapabilities = require('./capabilities')

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

  return rc
}

function enableWafUpdate (appsecConfig) {
  if (rc && appsecConfig && !appsecConfig.customRulesProvided) {
    // dirty require to make startup faster for serverless
    const RuleManager = require('../rule_manager')

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
    // TODO: we should have a different capability for rule override
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_DD_RULES, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)

    rc.on('ASM_DATA', noop)
    rc.on('ASM_DD', noop)
    rc.on('ASM', noop)

    rc.on(RemoteConfigManager.kPreUpdate, RuleManager.updateWafFromRC)
  }
}

function disableWafUpdate () {
  if (rc) {
    const RuleManager = require('../rule_manager')

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_IP_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_USER_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_DD_RULES, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXCLUSIONS, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_RULES, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_TRUSTED_IPS, false)

    rc.off('ASM_DATA', noop)
    rc.off('ASM_DD', noop)
    rc.off('ASM', noop)

    rc.off(RemoteConfigManager.kPreUpdate, RuleManager.updateWafFromRC)
  }
}

function noop () {}

module.exports = {
  enable,
  enableWafUpdate,
  disableWafUpdate
}
