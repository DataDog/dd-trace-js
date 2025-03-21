'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const WAFContextWrapper = require('./waf_context_wrapper')

const contexts = new WeakMap()

class WAFManager {
  constructor (rules, config) {
    this.config = config
    this.wafTimeout = config.wafTimeout
    this.ddwaf = this._loadDDWAF(rules)
    this.rulesVersion = this.ddwaf.diagnostics.ruleset_version

    Reporter.reportWafInit(this.ddwafVersion, this.rulesVersion, this.ddwaf.diagnostics.rules, true)
  }

  _loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')
      this.ddwafVersion = DDWAF.version()

      const { obfuscatorKeyRegex, obfuscatorValueRegex } = this.config
      return new DDWAF(rules, { obfuscatorKeyRegex, obfuscatorValueRegex })
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

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
