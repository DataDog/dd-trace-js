'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const addresses = require('../addresses')
const { getBlockingAction } = require('../blocking')

// TODO: remove once ephemeral addresses are implemented
const preventDuplicateAddresses = new Set([
  addresses.HTTP_INCOMING_QUERY
])

class WAFContextWrapper {
  constructor (ddwafContext, wafTimeout, wafVersion, rulesVersion, knownAddresses) {
    this.ddwafContext = ddwafContext
    this.wafTimeout = wafTimeout
    this.wafVersion = wafVersion
    this.rulesVersion = rulesVersion
    this.addressesToSkip = new Set()
    this.knownAddresses = knownAddresses
  }

  run ({ persistent, ephemeral }, raspRuleType) {
    if (this.ddwafContext.disposed) {
      log.warn('Calling run on a disposed context')
      return
    }

    const payload = {}
    let payloadHasData = false
    const persistentInputs = {}
    const ephemeralInputs = {}
    const newAddressesToSkip = new Set(this.addressesToSkip)

    if (persistent !== null && typeof persistent === 'object') {
      // TODO: possible optimization: only send params that haven't already been sent with same value to this wafContext
      for (const key of Object.keys(persistent)) {
        // TODO: requiredAddresses is no longer used due to processor addresses are not included in the list. Check on
        // future versions when the actual addresses are included in the 'loaded' section inside diagnostics.
        if (!this.addressesToSkip.has(key) && this.knownAddresses.has(key)) {
          persistentInputs[key] = persistent[key]
          if (preventDuplicateAddresses.has(key)) {
            newAddressesToSkip.add(key)
          }
        }
      }
    }

    if (ephemeral !== null && typeof ephemeral === 'object') {
      for (const key of Object.keys(ephemeral)) {
        if (this.knownAddresses.has(key)) {
          ephemeralInputs[key] = ephemeral[key]
        }
      }
    }

    if (Object.keys(persistentInputs).length) {
      payload.persistent = persistentInputs
      payloadHasData = true
    }

    if (Object.keys(ephemeralInputs).length) {
      payload.ephemeral = ephemeralInputs
      payloadHasData = true
    }

    if (!payloadHasData) return

    try {
      const start = process.hrtime.bigint()

      const result = this.ddwafContext.run(payload, this.wafTimeout)

      const end = process.hrtime.bigint()

      this.addressesToSkip = newAddressesToSkip

      const ruleTriggered = !!result.events?.length

      const blockTriggered = !!getBlockingAction(result.actions)

      Reporter.reportMetrics({
        duration: result.totalRuntime / 1e3,
        durationExt: parseInt(end - start) / 1e3,
        rulesVersion: this.rulesVersion,
        ruleTriggered,
        blockTriggered,
        wafVersion: this.wafVersion,
        wafTimeout: result.timeout
      }, raspRuleType)

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
