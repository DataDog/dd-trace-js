'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const addresses = require('../addresses')
const web = require('../../plugins/util/web')
const { storage } = require('../../../../datadog-core')
const WAFContextWrapper = require('./waf_context_wrapper')

const validAddressSet = new Set(Object.values(addresses))
const WAF_ENGINE_CONTEXT_KEY = Symbol('WAF_ENGINE_CONTEXT')
// TODO MAX_CONTEXT_SIZE = 1024

class WAFManager {
  constructor (rules, config) {
    this.config = config
    this.wafTimeout = config.wafTimeout
    this.reload(rules)
  }

  reload (rules) {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
    this.ddwaf = this._loadDDWAF(rules)
    this._reportMetrics()
    this._reloadAcceptedAddresses(rules)
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

  _reloadAcceptedAddresses (rules) {
    const acceptedAddresses = new Set()
    // add fields needed for HTTP context reporting
    acceptedAddresses.add(addresses.HTTP_INCOMING_HEADERS)
    acceptedAddresses.add(addresses.HTTP_INCOMING_ENDPOINT)
    acceptedAddresses.add(addresses.HTTP_INCOMING_RESPONSE_HEADERS)
    acceptedAddresses.add(addresses.HTTP_INCOMING_REMOTE_IP)

    for (const rule of rules.rules) {
      for (const condition of rule.conditions) {
        for (const input of condition.parameters.inputs) {
          const address = input.address.split(':', 1)[0]

          if (!validAddressSet.has(address) || acceptedAddresses.has(address)) continue

          acceptedAddresses.add(address)
        }
      }
    }
    this.acceptedAddresses = acceptedAddresses
  }
  createDDWAFContext (req) {
    const ddwafContext = new WAFContextWrapper(this.ddwaf.createContext(), this.acceptedAddresses,
      this.wafTimeout, this.ddwaf.rulesInfo)
    const requestContext = web.getContext(req)
    requestContext[WAF_ENGINE_CONTEXT_KEY] = ddwafContext
    return ddwafContext
  }

  getDDWAFContext (req) {
    if (!req) {
      const store = storage.getStore()
      req = store && store.req
    }
    const requestContext = web.getContext(req)
    return requestContext[WAF_ENGINE_CONTEXT_KEY]
  }

  update (rules) {
    this.ddwaf.update(rules)
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
