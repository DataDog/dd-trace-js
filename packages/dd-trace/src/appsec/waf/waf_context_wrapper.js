'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const addresses = require('../addresses')
const { getBlockingAction } = require('../blocking')
const { wafRunFinished } = require('../channels')

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
    this.cachedUserIdActions = new Map()
  }

  run ({ persistent, ephemeral }, raspRule) {
    if (this.ddwafContext.disposed) {
      log.warn('[ASM] Calling run on a disposed context')
      return
    }

    // SPECIAL CASE FOR USER_ID
    // TODO: make this universal
    const userId = persistent?.[addresses.USER_ID] || ephemeral?.[addresses.USER_ID]
    if (userId) {
      const cachedAction = this.cachedUserIdActions.get(userId)
      if (cachedAction) {
        return cachedAction
      }
    }

    const payload = {}
    let payloadHasData = false
    const newAddressesToSkip = new Set(this.addressesToSkip)

    if (persistent !== null && typeof persistent === 'object') {
      const persistentInputs = {}

      for (const key of Object.keys(persistent)) {
        if (!this.addressesToSkip.has(key) && this.knownAddresses.has(key)) {
          persistentInputs[key] = persistent[key]
          if (preventDuplicateAddresses.has(key)) {
            newAddressesToSkip.add(key)
          }
        }
      }

      if (Object.keys(persistentInputs).length) {
        payload.persistent = persistentInputs
        payloadHasData = true
      }
    }

    if (ephemeral !== null && typeof ephemeral === 'object') {
      const ephemeralInputs = {}

      for (const key of Object.keys(ephemeral)) {
        if (this.knownAddresses.has(key)) {
          ephemeralInputs[key] = ephemeral[key]
        }
      }

      if (Object.keys(ephemeralInputs).length) {
        payload.ephemeral = ephemeralInputs
        payloadHasData = true
      }
    }

    if (!payloadHasData) return

    try {
      const start = process.hrtime.bigint()

      const result = this.ddwafContext.run(payload, this.wafTimeout)

      const end = process.hrtime.bigint()

      this.addressesToSkip = newAddressesToSkip

      const ruleTriggered = !!result.events?.length

      const blockTriggered = !!getBlockingAction(result.actions)

      // SPECIAL CASE FOR USER_ID
      // TODO: make this universal
      if (userId && ruleTriggered && blockTriggered) {
        this.setUserIdCache(userId, result)
      }

      Reporter.reportMetrics({
        duration: result.totalRuntime / 1e3,
        durationExt: parseInt(end - start) / 1e3,
        rulesVersion: this.rulesVersion,
        ruleTriggered,
        blockTriggered,
        wafVersion: this.wafVersion,
        wafTimeout: result.timeout
      }, raspRule)

      if (ruleTriggered) {
        Reporter.reportAttack(JSON.stringify(result.events))
      }

      Reporter.reportDerivatives(result.derivatives)

      if (wafRunFinished.hasSubscribers) {
        wafRunFinished.publish({ payload })
      }

      return result.actions
    } catch (err) {
      log.error('[ASM] Error while running the AppSec WAF', err)
    }
  }

  setUserIdCache (userId, result) {
    // using old loops for speed
    for (let i = 0; i < result.events.length; i++) {
      const event = result.events[i]

      for (let j = 0; j < event?.rule_matches?.length; j++) {
        const match = event.rule_matches[j]

        for (let k = 0; k < match?.parameters?.length; k++) {
          const parameter = match.parameters[k]

          if (parameter?.address === addresses.USER_ID) {
            this.cachedUserIdActions.set(userId, result.actions)
            return
          }
        }
      }
    }
  }

  dispose () {
    this.ddwafContext.dispose()
  }
}

module.exports = WAFContextWrapper
