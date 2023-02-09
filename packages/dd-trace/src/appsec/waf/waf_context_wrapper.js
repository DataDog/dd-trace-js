'use strict'

const Reporter = require('../reporter')

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

module.exports = WAFContextWrapper
