'use strict'

const Activation = require('./activation')
const { setCollectionMode } = require('./user_tracking')
const log = require('../log')
const { updateConfig } = require('../telemetry')
const RemoteConfigCapabilities = require('../remote_config/capabilities')

let autoUserInstrumModeId
let rc

/**
 * Configures remote config handlers for appsec features
 * @param {Object} rcInstance - RemoteConfigManager instance
 *
 * @param {Object} config - Tracer config
 * @param {Object} appsec - Appsec module
 */
function enable (rcInstance, config, appsec) {
  rc = rcInstance
  const activation = Activation.fromConfig(config)

  if (activation !== Activation.DISABLED) {
    if (activation === Activation.ONECLICK) {
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_ACTIVATION, true)
    }

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)

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
}

/**
 * Enables or disables appsec based on remote config
 *
 * @param {string} action - 'apply', 'modify', or 'unapply'
 * @param {Object} rcConfig - Remote config
 * @param {Object} config - Tracer config
 * @param {Object} appsec - Appsec module
 */
function enableOrDisableAppsec (action, rcConfig, config, appsec) {
  if (typeof rcConfig.asm?.enabled === 'boolean') {
    const isRemoteConfigControlling = action === 'apply' || action === 'modify'
    const shouldEnable = isRemoteConfigControlling
      ? rcConfig.asm.enabled // take control
      : config.appsec.enabled // give back control to local config

    if (shouldEnable) {
      appsec.enable(config)
    } else {
      appsec.disable()
    }

    updateConfig([
      {
        name: 'appsec.enabled',
        origin: isRemoteConfigControlling ? 'remote_config' : config.getOrigin('appsec.enabled'),
        value: shouldEnable
      }
    ], config)
  }
}

/**
 * Enables WAF update capabilities for remote config
 *
 * @param {Object} appsecConfig - Appsec config
 */
function enableWafUpdate (appsecConfig) {
  if (rc && appsecConfig && !appsecConfig.rules) {
    // dirty require to make startup faster for serverless
    const { ASM_WAF_PRODUCTS } = require('./rc-products')
    const RuleManager = require('./rule_manager')

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
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_PROCESSOR_OVERRIDES, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_DATA_SCANNERS, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXCLUSION_DATA, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_SESSION_FINGERPRINT, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_DD_MULTICONFIG, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_TRACE_TAGGING_RULES, true)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXTENDED_DATA_COLLECTION, true)

    if (appsecConfig.rasp?.enabled) {
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SQLI, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SSRF, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_LFI, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SHI, true)
      rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_CMDI, true)
    }

    rc.subscribeProducts(...ASM_WAF_PRODUCTS)
    rc.setBatchHandler(ASM_WAF_PRODUCTS, RuleManager.updateWafFromRC)
  }
}

/**
 * Disables WAF update capabilities for remote config
 */
function disableWafUpdate () {
  if (rc) {
    const { ASM_WAF_PRODUCTS } = require('./rc-products')
    const RuleManager = require('./rule_manager')

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_IP_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_USER_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_DD_RULES, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXCLUSIONS, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_RULES, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_TRUSTED_IPS, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_PROCESSOR_OVERRIDES, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_CUSTOM_DATA_SCANNERS, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXCLUSION_DATA, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_SESSION_FINGERPRINT, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_DD_MULTICONFIG, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_TRACE_TAGGING_RULES, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_EXTENDED_DATA_COLLECTION, false)

    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SQLI, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SSRF, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_LFI, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_SHI, false)
    rc.updateCapabilities(RemoteConfigCapabilities.ASM_RASP_CMDI, false)

    rc.unsubscribeProducts(...ASM_WAF_PRODUCTS)
    rc.removeBatchHandler(RuleManager.updateWafFromRC)
  }
}

module.exports = {
  enable,
  enableWafUpdate,
  disableWafUpdate
}
