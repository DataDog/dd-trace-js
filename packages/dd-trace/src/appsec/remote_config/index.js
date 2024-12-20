'use strict'

const Activation = require('../activation')

const RemoteConfigManager = require('./manager')
const RemoteConfigCapabilities = require('./capabilities')
const { setCollectionMode } = require('../user_tracking')
const log = require('../../log')

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

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)

    let autoUserInstrumModeId

    rc.setProductHandler('ASM_FEATURES', (action, rcConfig, configId) => {
      if (!rcConfig) return

      // this is put before other handlers because it can reject the config
      if (typeof rcConfig.auto_user_instrum?.mode === 'string') {
        if (action === 'apply' || action === 'modify') {
          // check if there is already a config applied with this field
          if (autoUserInstrumModeId && configId !== autoUserInstrumModeId) {
            log.error('[RC] Multiple auto_user_instrum received in ASM_FEATURES. Discarding config')
            // eslint-disable-next-line no-throw-literal
            throw 'Multiple auto_user_instrum.mode received in ASM_FEATURES'
          }

          setCollectionMode(rcConfig.auto_user_instrum.mode)
          autoUserInstrumModeId = configId
        } else if (configId === autoUserInstrumModeId) {
          setCollectionMode(config.appsec.eventTracking.mode)
          autoUserInstrumModeId = null
        }
      }

      if (activation === Activation.ONECLICK) {
        enableOrDisableAppsec(action, rcConfig, config, appsec)
      }
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
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, true)

    if (appsecConfig.rasp?.enabled) {
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SQLI, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SSRF, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_LFI, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SHI, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_CMDI, true)
    }

    // TODO: delete noop handlers and kPreUpdate and replace with batched handlers
    rc.setProductHandler('ASM_DATA', noop)
    rc.setProductHandler('ASM_DD', noop)
    rc.setProductHandler('ASM', noop)

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
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, false)

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SQLI, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SSRF, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_LFI, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SHI, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_CMDI, false)

    rc.removeProductHandler('ASM_DATA')
    rc.removeProductHandler('ASM_DD')
    rc.removeProductHandler('ASM')

    rc.off(RemoteConfigManager.kPreUpdate, RuleManager.updateWafFromRC)
  }
}

function noop () {}

module.exports = {
  enable,
  enableWafUpdate,
  disableWafUpdate
}
