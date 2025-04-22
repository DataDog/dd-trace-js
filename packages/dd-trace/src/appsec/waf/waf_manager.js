'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const WAFContextWrapper = require('./waf_context_wrapper')

const contexts = new WeakMap()

const DEFAULT_WAF_CONFIG_PATH = 'datadog/00/ASM_DD/default/config'

class WAFManager {
  constructor (rules, config) {
    this.config = config
    this.wafTimeout = config.wafTimeout
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

      const { obfuscatorKeyRegex, obfuscatorValueRegex } = this.config
      return new DDWAF(rules, DEFAULT_WAF_CONFIG_PATH, { obfuscatorKeyRegex, obfuscatorValueRegex })
    } catch (err) {
      console.log('what happened', err)
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

  /*
  update (newRules) {
    try {
      this.ddwaf.update(newRules)

      if (this.ddwaf.diagnostics.ruleset_version) {
        this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
      }

      Reporter.reportWafUpdate(this.ddwafVersion, this.rulesVersion, true)
    } catch (error) {
      Reporter.reportWafUpdate(this.ddwafVersion, 'unknown', false)

      throw error
    }
  }
   */

  updateASMDD(config, path) {
    console.log(this.ddwaf.configPaths)
    if (this.ddwaf.configPaths.includes(DEFAULT_WAF_CONFIG_PATH)) {
      console.log('Removing default config')
      this.ddwaf.removeConfig(DEFAULT_WAF_CONFIG_PATH)
    }

    const success = this.ddwaf.createOrUpdateConfig(config, path)

    if (!this.ddwaf.configPaths.some(cp => cp.includes('ASM_DD'))) {
      console.log('Reverting default rules')
      this.ddwaf.createOrUpdateConfig(this.defaultRules, DEFAULT_WAF_CONFIG_PATH)
    }

    if (this.ddwaf.diagnostics.ruleset_version) {
      this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    }

    Reporter.reportWafUpdate(this.ddwafVersion, this.rulesVersion, success)
    return { success }
  }

  update (rules, path) {
    try {
      console.log('removeConfig path', path)
      this.ddwaf.removeConfig(path)
      console.log('createOrUpdateConfig path', path)
      const success = this.ddwaf.createOrUpdateConfig(rules, path)

      if (this.ddwaf.diagnostics.ruleset_version) {
        this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
      }

      Reporter.reportWafUpdate(this.ddwafVersion, this.rulesVersion, success)
      return { success }
    } catch (error) {
      Reporter.reportWafUpdate(this.ddwafVersion, 'unknown', false)

      throw error
    }

  }

  remove (path) {
    try {
      console.log('removeConfig path', path)
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
