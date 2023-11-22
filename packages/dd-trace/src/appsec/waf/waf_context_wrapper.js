'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const addresses = require('../addresses')

// TODO: remove once ephemeral addresses are implemented
const preventDuplicateAddresses = new Set([
  addresses.HTTP_INCOMING_QUERY
])

class WAFContextWrapper {
  constructor (ddwafContext, wafTimeout, wafVersion, rulesVersion) {
    this.ddwafContext = ddwafContext
    this.wafTimeout = wafTimeout
    this.wafVersion = wafVersion
    this.rulesVersion = rulesVersion
    this.addressesToSkip = new Set()
  }

  run (params) {
    const inputs = {}
    let someInputAdded = false
    const newAddressesToSkip = new Set(this.addressesToSkip)

    // TODO: possible optimizaion: only send params that haven't already been sent with same value to this wafContext
    for (const key of Object.keys(params)) {
      // TODO: requiredAddresses is no longer used due to processor addresses are not included in the list. Check on
      // future versions when the actual addresses are included in the 'loaded' section inside diagnostics.
      if (!this.addressesToSkip.has(key)) {
        inputs[key] = params[key]
        if (preventDuplicateAddresses.has(key)) {
          newAddressesToSkip.add(key)
        }
        someInputAdded = true
      }
    }

    if (!someInputAdded) return

    try {
      const start = process.hrtime.bigint()

      const result = this.ddwafContext.run(inputs, this.wafTimeout)

      const end = process.hrtime.bigint()

      this.addressesToSkip = newAddressesToSkip

      const ruleTriggered = !!result.events?.length
      const blockTriggered = result.actions?.includes('block')

      Reporter.reportMetrics({
        duration: result.totalRuntime / 1e3,
        durationExt: parseInt(end - start) / 1e3,
        rulesVersion: this.rulesVersion,
        ruleTriggered,
        blockTriggered,
        wafVersion: this.wafVersion,
        wafTimeout: result.timeout
      })

      if (ruleTriggered) {
        Reporter.reportAttack(JSON.stringify(result.events))
      }

      Reporter.reportSchemas(result.derivatives)

      return result.actions
    } catch (err) {
      log.error('Error while running the AppSec WAF')
      log.error(err)
    }
  }

  dispose () {
    this.ddwafContext.dispose()
  }
}

module.exports = WAFContextWrapper
