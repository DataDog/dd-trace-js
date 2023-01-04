'use strict'

const log = require('../log')
const Reporter = require('./reporter')
const addresses = require('./addresses')
const web = require('../plugins/util/web')
const { storage } = require('../../../datadog-core')

const validAddressSet = new Set(Object.values(addresses))
const WAF_ENGINE_CONTEXT_KEY = Symbol('WAF_ENGINE_CONTEXT')
// TODO MAX_CONTEXT_SIZE = 1024

class WAFContextWrapper {
  constructor (ddwafContext, acceptedAddresses, wafTimeout, rulesInfo) {
    this.ddwafContext = ddwafContext
    this.acceptedAddresses = acceptedAddresses
    this.wafTimeout = wafTimeout
    this.rulesInfo = rulesInfo
  }

  run (params) {
    const inputs = {}
    let someInputAdded = false
    params && Object.keys(params).forEach((key) => {
      if (this.acceptedAddresses.has(key)) {
        inputs[key] = params[key]
        someInputAdded = true
      }
    })
    if (someInputAdded) {
      const start = process.hrtime.bigint()

      const ddwafResult = this.ddwafContext.run(inputs, this.wafTimeout)

      ddwafResult.durationExt = parseInt(process.hrtime.bigint() - start)
      return this._applyResult(ddwafResult, inputs)
    }
    return []
  }

  _applyResult (result, params) {
    Reporter.reportMetrics({
      duration: result.totalRuntime / 1e3,
      durationExt: result.durationExt / 1e3,
      rulesVersion: this.rulesInfo.version
    })
    if (result.data && result.data !== '[]') {
      Reporter.reportAttack(result.data, params)
    }

    return result.actions
  }
  dispose () {
    if (!this.ddwafContext.disposed) {
      this.ddwafContext.dispose()
    }
  }
}

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

  updateRuleData (ruleData) {
    this.ddwaf.updateRuleData(ruleData)
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

function init (rules, config) {
  if (!wafManagerModule.wafManager) {
    wafManagerModule.wafManager = new WAFManager(rules, config)
  }
}

function destroy () {
  if (wafManagerModule.wafManager) {
    wafManagerModule.wafManager.destroy()
    wafManagerModule.wafManager = null
  }
}

const wafManagerModule = {
  WAFContextWrapper,
  WAFManager,
  init,
  destroy,
  wafManager: null
}
module.exports = wafManagerModule
