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
    this._reportMetrics()
  }

  _loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')

      const { obfuscatorKeyRegex, obfuscatorValueRegex } = this.config
      return new DDWAF(rules, { obfuscatorKeyRegex, obfuscatorValueRegex })
    } catch (err) {
      log.error('AppSec could not load native package. In-app WAF features will not be available.')

      throw err
    }
  }

  _reportMetrics () {
    Reporter.reportInitMetrics({ wafVersion: this.getWAFVersion(), eventRules: this.ddwaf.rulesInfo })
  }

  getWAFContext (req) {
    let wafContext = contexts.get(req)

    if (!wafContext) {
      wafContext = new WAFContextWrapper(
        this.ddwaf.createContext(),
        this.ddwaf.requiredAddresses,
        this.wafTimeout,
        this.ddwaf.rulesInfo,
        this.getWAFVersion()
      )
      contexts.set(req, wafContext)
    }

    return wafContext
  }

  getWAFVersion () {
    return this.ddwaf.constructor.version()
  }

  update (newRules) {
    this.ddwaf.update(newRules)

    Reporter.reportUpdateRuleData(this.getWAFVersion(), this.ddwaf.rulesInfo.version)
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
