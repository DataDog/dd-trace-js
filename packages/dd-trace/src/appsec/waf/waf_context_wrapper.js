'use strict'

const log = require('../../log')
const Reporter = require('../reporter')

class WAFContextWrapper {
  constructor (ddwafContext, requiredAddresses, wafTimeout, rulesInfo) {
    this.ddwafContext = ddwafContext
    this.requiredAddresses = requiredAddresses
    this.wafTimeout = wafTimeout
    this.rulesInfo = rulesInfo
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

      Reporter.reportMetrics({
        duration: result.totalRuntime / 1e3,
        durationExt: parseInt(end - start) / 1e3,
        rulesVersion: this.rulesInfo.version
      })

      if (result.data && result.data !== '[]') {
        Reporter.reportAttack(result.data)
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
