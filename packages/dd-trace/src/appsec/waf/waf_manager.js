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
    Reporter.metricsQueue.set('_dd.appsec.waf.version', this.ddwaf.constructor.version())

    const { loaded, failed, errors } = this.ddwaf.rulesInfo

    Reporter.metricsQueue.set('_dd.appsec.event_rules.loaded', loaded)
    Reporter.metricsQueue.set('_dd.appsec.event_rules.error_count', failed)
    if (failed) Reporter.metricsQueue.set('_dd.appsec.event_rules.errors', JSON.stringify(errors))

    Reporter.metricsQueue.set('manual.keep', 'true')
  }

  getWAFContext (req) {
    let wafContext = contexts.get(req)

    if (!wafContext) {
      wafContext = new WAFContextWrapper(
        this.ddwaf.createContext(),
        this.ddwaf.requiredAddresses,
        this.wafTimeout,
        this.ddwaf.rulesInfo
      )
      contexts.set(req, wafContext)
    }

    return wafContext
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
