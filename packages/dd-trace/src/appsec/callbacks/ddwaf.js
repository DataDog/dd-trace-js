'use strict'

const log = require('../../log')
const addresses = require('../addresses')
const Gateway = require('../gateway/engine')
const Reporter = require('../reporter')

let warned = false

const validAddressSet = new Set(Object.values(addresses))

const DEFAULT_MAX_BUDGET = 5e3 // µs

// TODO: put reusable code in a base class
class WAFCallback {
  static loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')

      return new DDWAF(rules)
    } catch (err) {
      if (!warned) {
        log.warn('AppSec could not load native package. In-app WAF features will not be available.')
        warned = true
      }

      throw err
    }
  }

  constructor (rules) {
    this.ddwaf = WAFCallback.loadDDWAF(rules)
    this.wafContextCache = new WeakMap()

    // closures are faster than binds
    const self = this
    const method = (params, store) => {
      return self.action(params, store)
    }

    // might be its own class with more info later
    const callback = { method }

    const subscribedAddresses = new Set()

    for (const rule of rules.rules) {
      for (const condition of rule.conditions) {
        for (const input of condition.parameters.inputs) {
          const address = input.address.split(':', 2)[0]

          if (!validAddressSet.has(address) || subscribedAddresses.has(address)) continue

          subscribedAddresses.add(address)

          Gateway.manager.addSubscription({ addresses: [ address ], callback })
        }
      }
    }
  }

  action (params, store) {
    let wafContext

    if (store) {
      const key = store.get('context')

      if (key) {
        if (this.wafContextCache.has(key)) {
          wafContext = this.wafContextCache.get(key)
        } else {
          wafContext = this.ddwaf.createContext()
          this.wafContextCache.set(key, wafContext)
        }
      }
    }

    if (!wafContext) {
      wafContext = this.ddwaf.createContext()
    }

    // cast status code to string
    if (params[addresses.HTTP_INCOMING_RESPONSE_CODE]) {
      params[addresses.HTTP_INCOMING_RESPONSE_CODE] = params[addresses.HTTP_INCOMING_RESPONSE_CODE] + ''
    }

    try {
      // TODO: possible optimizaion: only send params that haven't already been sent to this wafContext
      const result = wafContext.run(params, DEFAULT_MAX_BUDGET)

      return this.applyResult(result, store)
    } catch (err) {
      log.error('Error while running the AppSec WAF')
      log.error(err)
    }
  }

  applyResult (result, store) {
    if (result.data && result.data !== '[]') {
      Reporter.reportAttack(result.data, store)
    }

    // TODO: use these values later for budget management
    // result.perfData
    // result.perfTotalRuntime
  }

  clear () {
    this.ddwaf.dispose()

    this.wafContextCache = new WeakMap()

    Gateway.manager.clear()
  }
}

module.exports = WAFCallback
