'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const WAFContextWrapper = require('./waf_context_wrapper')

const contexts = new WeakMap()

const DEFAULT_WAF_CONFIG_PATH = 'datadog/00/ASM_DD/default/config'
const DIAGNOSTICS_KEYS_TO_KEEP_APPLY_ERROR = [
  "error", "errors",
  "exclusions", "rules", "processors", "rules_override", "rules_data", "custom_rules", "actions", "scanners"
]

class WAFManager {
  constructor (rules, config) {
    this.config = config
    this.wafTimeout = config.wafTimeout
    this.ddwaf = this._loadDDWAF(rules)
    this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    this.defaultRules = rules

    Reporter.reportWafInit(this.ddwafVersion, this.rulesVersion, this.ddwaf.diagnostics.rules, true)
  }

  static computeUpdateWafError (diagnostics) {
    return JSON.stringify(diagnostics, DIAGNOSTICS_KEYS_TO_KEEP_APPLY_ERROR)
  }

  _loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')
      this.ddwafVersion = DDWAF.version()

      const { obfuscatorKeyRegex, obfuscatorValueRegex } = this.config
      return new DDWAF(rules, DEFAULT_WAF_CONFIG_PATH, { obfuscatorKeyRegex, obfuscatorValueRegex })
    } catch (err) {
      this.ddwafVersion = this.ddwafVersion || 'unknown'
      Reporter.reportWafInit(this.ddwafVersion, 'unknown')

      log.error('[ASM] AppSec could not load native package. In-app WAF features will not be available.')

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

  update (product, rules, path) {
    try {
      if (product === 'ASM_DD' && this.ddwaf.configPaths.includes(DEFAULT_WAF_CONFIG_PATH)) {
        this.ddwaf.removeConfig(DEFAULT_WAF_CONFIG_PATH)
      }

      const success = this.ddwaf.createOrUpdateConfig(rules, path)
      const updateDiagnostics = this.ddwaf.diagnostics

      if (updateDiagnostics.ruleset_version) {
        this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
      }

      Reporter.reportWafUpdate(this.ddwafVersion, this.rulesVersion, success)

      if (product === 'ASM_DD' && !success && !this.ddwaf.configPaths.some(cp => cp.includes('ASM_DD'))) {
        this.ddwaf.createOrUpdateConfig(this.defaultRules, DEFAULT_WAF_CONFIG_PATH)
      }

      return { success, error: !success ? WAFManager.computeUpdateWafError(updateDiagnostics) : undefined }
    } catch (error) {
      Reporter.reportWafUpdate(this.ddwafVersion, 'unknown', false)

      throw error
    }

  }

  remove (path) {
    try {
      this.ddwaf.removeConfig(path)

      if (!this.ddwaf.configPaths.some(cp => cp.includes('ASM_DD'))) {
        console.log('Reverting default rules')
        this.ddwaf.createOrUpdateConfig(this.defaultRules, DEFAULT_WAF_CONFIG_PATH)
      }

      if (this.ddwaf.diagnostics.ruleset_version) {
        this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
      }

      Reporter.reportWafUpdate(this.ddwafVersion, this.rulesVersion, true)
    } catch (error) {
      Reporter.reportWafUpdate(this.ddwafVersion, 'unknown', false)

      throw error
    }
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
