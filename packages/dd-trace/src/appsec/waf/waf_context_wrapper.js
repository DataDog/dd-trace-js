'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const addresses = require('../addresses')
const { getBlockingAction } = require('../blocking')
const { wafRunFinished } = require('../channels')

// Some HTTP hooks can supply the same query more than once.
const preventDuplicateAddresses = new Set([
  addresses.HTTP_INCOMING_QUERY,
])

class WAFContextWrapper {
  constructor (ddwafContext, wafTimeout, wafVersion, rulesVersion, knownAddresses, req, parent) {
    this.ddwafContext = ddwafContext
    this.parent = parent
    this.req = req
    this.wafTimeout = wafTimeout
    this.wafVersion = wafVersion
    this.rulesVersion = rulesVersion
    this.knownAddresses = knownAddresses
    this.addressesToSkip = new Set()
    this.cachedUserIdResults = new Map()
    // Reused across run() calls; Reporter.reportMetrics consumes it synchronously.
    this.metrics = {
      rulesVersion,
      wafVersion,
      wafTimeout: false,
      duration: 0,
      durationExt: 0,
      blockTriggered: false,
      ruleTriggered: false,
      errorCode: null,
      maxTruncatedString: null,
      maxTruncatedContainerSize: null,
      maxTruncatedContainerDepth: null,
    }
  }

  run (data, raspRule, rootSpan) {
    if (this.ddwafContext.disposed) {
      log.warn('[ASM] Calling run on a disposed context')
      if (raspRule) {
        Reporter.reportRaspRuleSkipped(raspRule, 'after-request')
      }

      return
    }

    const req = this.req
    const userId = data?.[addresses.USER_ID]
    if (userId) {
      const cachedResults = this.cachedUserIdResults.get(userId)
      if (cachedResults) {
        return cachedResults
      }
    }

    const payload = {}
    let payloadHasData = false
    // Cloned lazily; only the preventDuplicateAddresses branch below adds to it.
    let newAddressesToSkip

    if (data !== null && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        if (!this.addressesToSkip.has(key) && this.knownAddresses.has(key)) {
          payloadHasData = true
          payload[key] = data[key]
          if (!this.parent && preventDuplicateAddresses.has(key)) {
            newAddressesToSkip ??= new Set(this.addressesToSkip)
            newAddressesToSkip.add(key)
          }
        }
      }
    }

    if (!payloadHasData) return

    const metrics = this.metrics
    metrics.wafTimeout = false
    metrics.duration = 0
    metrics.durationExt = 0
    metrics.blockTriggered = false
    metrics.ruleTriggered = false
    metrics.errorCode = null
    metrics.maxTruncatedString = null
    metrics.maxTruncatedContainerSize = null
    metrics.maxTruncatedContainerDepth = null

    try {
      const start = process.hrtime.bigint()

      const result = this.ddwafContext.run(payload, this.wafTimeout)

      const end = process.hrtime.bigint()

      metrics.durationExt = Number(end - start) / 1e3

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

      if (newAddressesToSkip !== undefined) {
        this.addressesToSkip = newAddressesToSkip
      }

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
        Reporter.reportAttack(result, req, rootSpan)
      }

      Reporter.reportAttributes(result.attributes, req, rootSpan)

      return result
    } catch (err) {
      log.error('[ASM] Error while running the AppSec WAF', err)

      metrics.errorCode = err.errorCode ?? -127
    } finally {
      if (wafRunFinished.hasSubscribers) {
        wafRunFinished.publish({ payload, req, isSubcontext: !!this.parent })
      }

      Reporter.reportMetrics(metrics, raspRule, req, rootSpan)
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

  createSubcontext () {
    if (this.parent || this.ddwafContext.disposed) return
    try {
      const subcontext = new WAFContextWrapper(
        this.ddwafContext.createSubcontext(), this.wafTimeout, this.wafVersion,
        this.rulesVersion, this.knownAddresses, this.req, this
      )
      this.subcontexts ??= new Set()
      this.subcontexts.add(subcontext)
      return subcontext
    } catch (error) {
      log.error('[ASM] Error creating an AppSec WAF subcontext', error)
    }
  }

  dispose () {
    this.parent?.subcontexts.delete(this)
    if (this.subcontexts) {
      for (const subcontext of this.subcontexts) subcontext.dispose()
    }
    if (!this.ddwafContext.disposed) this.ddwafContext.dispose()
  }
}

module.exports = WAFContextWrapper
