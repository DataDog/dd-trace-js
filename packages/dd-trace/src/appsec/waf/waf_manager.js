'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const WAFContextWrapper = require('./waf_context_wrapper')

const contexts = new WeakMap()

/**
 * @typedef {object} WAFManagerConfig
 * @property {number} DD_APPSEC_WAF_TIMEOUT - Maximum time in microseconds for WAF execution
 * @property {string} DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP - Regex to redact sensitive data by key
 * @property {string} DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP - Regex to redact sensitive data by value
 */

class WAFManager {
  static defaultWafConfigPath = 'datadog/00/ASM_DD/default/config'

  /**
   * @param {object} rules
   * @param {WAFManagerConfig} config
   */
  constructor (rules, config) {
    this.config = config
    this.wafTimeout = config.DD_APPSEC_WAF_TIMEOUT
    this.ddwaf = this._loadDDWAF(rules)
    this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    this.defaultRules = rules

    Reporter.reportWafInit(this.ddwafVersion, this.rulesVersion, this.ddwaf.diagnostics.rules, true)
  }

  _loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')
      this.ddwafVersion = DDWAF.version()

      const {
        DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP: obfuscatorKeyRegex,
        DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP: obfuscatorValueRegex,
      } = this.config
      return new DDWAF(rules, WAFManager.defaultWafConfigPath, { obfuscatorKeyRegex, obfuscatorValueRegex })
    } catch (err) {
      this.ddwafVersion ||= 'unknown'
      Reporter.reportWafInit(this.ddwafVersion, 'unknown')

      log.error('[ASM] AppSec could not load native package. In-app WAF features will not be available.', err)

      throw err
    }
  }

  getWAFContext (req) {
    let wafContext = contexts.get(req)

    if (!wafContext) {
      wafContext = new WAFContextWrapper(
        this.ddwaf.createContext(),
        this.wafTimeout,
        this.ddwafVersion,
        this.rulesVersion,
        this.ddwaf.knownAddresses
      )
      contexts.set(req, wafContext)
    }

    return wafContext
  }

  setRulesVersion () {
    if (this.ddwaf.diagnostics.ruleset_version) {
      this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    }
  }

  setAsmDdFallbackConfig () {
    if (!this.ddwaf.configPaths.some(cp => cp.includes('ASM_DD'))) {
      this.updateConfig(WAFManager.defaultWafConfigPath, this.defaultRules)
    }
  }

  updateConfig (path, rules) {
    const updateResult = this.ddwaf.createOrUpdateConfig(rules, path)
    this.setRulesVersion()
    return updateResult
  }

  removeConfig (path) {
    this.ddwaf.removeConfig(path)
    this.setRulesVersion()
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
