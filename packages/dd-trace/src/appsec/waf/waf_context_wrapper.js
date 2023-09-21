'use strict'

const log = require('../../log')
const Reporter = require('../reporter')

class WAFContextWrapper {
  constructor (ddwafContext, requiredAddresses, wafTimeout, wafVersion, rulesVersion) {
    this.ddwafContext = ddwafContext
    this.requiredAddresses = requiredAddresses
    this.wafTimeout = wafTimeout
    this.wafVersion = wafVersion
    this.rulesVersion = rulesVersion
  }

  run (params) {
    const inputs = {}
    let someInputAdded = false

    // TODO: possible optimizaion: only send params that haven't already been sent with same value to this wafContext
    for (const key of Object.keys(params)) {
      if (this.requiredAddresses.has(key)) {
        inputs[key] = params[key]
        someInputAdded = true
      }
    }

    if (!someInputAdded) return

    try {
      const start = process.hrtime.bigint()

      const result = this.ddwafContext.run(inputs, this.wafTimeout)

      const end = process.hrtime.bigint()

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
