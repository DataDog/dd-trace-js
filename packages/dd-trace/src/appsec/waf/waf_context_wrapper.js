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
    this.knownAddresses = knownAddresses
    this.addressesToSkip = new Set()
    this.cachedUserIdResults = new Map()
  }

  run ({ persistent, ephemeral }, raspRule) {
    if (this.ddwafContext.disposed) {
      log.warn('[ASM] Calling run on a disposed context')
      if (raspRule) {
        Reporter.reportRaspRuleSkipped(raspRule, 'after-request')
      }

      return
    }

    // SPECIAL CASE FOR USER_ID
    // TODO: make this universal
    const userId = persistent?.[addresses.USER_ID] || ephemeral?.[addresses.USER_ID]
    if (userId) {
      const cachedResults = this.cachedUserIdResults.get(userId)
      if (cachedResults) {
        return cachedResults
      }
    }

    const payload = {}
    let payloadHasData = false
    const newAddressesToSkip = new Set(this.addressesToSkip)

    if (persistent !== null && typeof persistent === 'object') {
      const persistentInputs = {}

      let hasPersistentInputs = false
      for (const key of Object.keys(persistent)) {
        if (!this.addressesToSkip.has(key) && this.knownAddresses.has(key)) {
          hasPersistentInputs = true
          persistentInputs[key] = persistent[key]
          if (preventDuplicateAddresses.has(key)) {
            newAddressesToSkip.add(key)
          }
        }
      }

      if (hasPersistentInputs) {
        payload.persistent = persistentInputs
        payloadHasData = true
      }
    }

    if (ephemeral !== null && typeof ephemeral === 'object') {
      const ephemeralInputs = {}

      let hasEphemeral = false
      for (const key of Object.keys(ephemeral)) {
        if (this.knownAddresses.has(key)) {
          hasEphemeral = true
          ephemeralInputs[key] = ephemeral[key]
        }
      }

      if (hasEphemeral) {
        payload.ephemeral = ephemeralInputs
        payloadHasData = true
      }
    }

    if (!payloadHasData) return

    const metrics = {
      rulesVersion: this.rulesVersion,
      wafVersion: this.wafVersion,
      wafTimeout: false,
      duration: 0,
      durationExt: 0,
      blockTriggered: false,
      ruleTriggered: false,
      errorCode: null,
      maxTruncatedString: null,
      maxTruncatedContainerSize: null,
      maxTruncatedContainerDepth: null
    }

    try {
      const start = process.hrtime.bigint()

      const result = this.ddwafContext.run(payload, this.wafTimeout)

      const end = process.hrtime.bigint()

      metrics.durationExt = Number.parseInt(end - start) / 1e3

      if (typeof result.errorCode === 'number' && result.errorCode < 0) {
        const error = new Error('WAF code error')
        error.errorCode = result.errorCode

        throw error
      }

      if (result.metrics) {
        const { maxTruncatedString, maxTruncatedContainerSize, maxTruncatedContainerDepth } = result.metrics

        if (maxTruncatedString) metrics.maxTruncatedString = maxTruncatedString
        if (maxTruncatedContainerSize) metrics.maxTruncatedContainerSize = maxTruncatedContainerSize
        if (maxTruncatedContainerDepth) metrics.maxTruncatedContainerDepth = maxTruncatedContainerDepth
      }

      this.addressesToSkip = newAddressesToSkip

      const ruleTriggered = !!result.events?.length

      const blockTriggered = !!getBlockingAction(result.actions)

      // SPECIAL CASE FOR USER_ID
      // TODO: make this universal
      if (userId && ruleTriggered && blockTriggered) {
        this.setUserIdCache(userId, result)
      }

      metrics.duration = result.duration / 1e3
      metrics.blockTriggered = blockTriggered
      metrics.ruleTriggered = ruleTriggered
      metrics.wafTimeout = result.timeout

      if (ruleTriggered) {
        Reporter.reportAttack(result.events)
      }

      Reporter.reportAttributes(result.attributes)

      return result
    } catch (err) {
      log.error('[ASM] Error while running the AppSec WAF', err)

      metrics.errorCode = err.errorCode ?? -127
    } finally {
      if (wafRunFinished.hasSubscribers) {
        wafRunFinished.publish({ payload })
      }

      Reporter.reportMetrics(metrics, raspRule)
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
            this.cachedUserIdResults.set(userId, result)
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
