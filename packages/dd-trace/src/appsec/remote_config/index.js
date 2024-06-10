'use strict'

const Activation = require('../activation')

const RemoteConfigManager = require('./manager')
const RemoteConfigCapabilities = require('./capabilities')
const apiSecuritySampler = require('../api_security_sampler')

let rc

function enable (config, appsec) {
  rc = new RemoteConfigManager(config)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)

  const activation = Activation.fromConfig(config)

  if (activation !== Activation.DISABLED) {
    if (activation === Activation.ONECLICK) {
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_ACTIVATION, true)
    }

    if (config.appsec.apiSecurity?.enabled) {
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_API_SECURITY_SAMPLE_RATE, true)
    }

    rc.on('ASM_FEATURES', (action, rcConfig) => {
      if (!rcConfig) return

      if (activation === Activation.ONECLICK) {
        enableOrDisableAppsec(action, rcConfig, config, appsec)
      }

      apiSecuritySampler.setRequestSampling(rcConfig.api_security?.request_sample_rate)
    })
  }

  return rc
}

function enableOrDisableAppsec (action, rcConfig, config, appsec) {
  if (typeof rcConfig.asm?.enabled === 'boolean') {
    let shouldEnable

    if (action === 'apply' || action === 'modify') {
      shouldEnable = rcConfig.asm.enabled // take control
    } else {
      shouldEnable = config.appsec.enabled // give back control to local config
    }

    if (shouldEnable) {
      appsec.enable(config)
    } else {
      appsec.disable()
    }
  }
}

function enableWafUpdate (appsecConfig) {
  if (rc && appsecConfig && !appsecConfig.rules) {
    // dirty require to make startup faster for serverless
    const RuleManager = require('../rule_manager')

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
    // TODO: we should have a different capability for rule override
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_DD_RULES, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, true)
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
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, false)
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
