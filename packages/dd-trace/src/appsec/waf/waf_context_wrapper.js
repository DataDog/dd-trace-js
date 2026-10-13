'use strict'

const log = require('../../log')
const Reporter = require('../reporter')
const addresses = require('../addresses')
const { getBlockingAction } = require('../blocking')
const { wafRunFinished } = require('../channels')
const { isEmpty } = require('../../util')

// TODO: remove once ephemeral addresses are implemented
const preventDuplicateAddresses = new Set([
  addresses.HTTP_INCOMING_QUERY,
])

class WAFContextWrapper {
  constructor (ddwafContext, wafTimeout, wafVersion, rulesVersion, knownAddresses) {
    this.ddwafContext = ddwafContext
    this.useSubcontexts = typeof ddwafContext.createSubcontext === 'function'
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

  run ({ persistent, ephemeral }, raspRule, req, rootSpan) {
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
    // Cloned lazily; only the preventDuplicateAddresses branch below adds to it.
    let newAddressesToSkip

    if (persistent !== null && typeof persistent === 'object') {
      const persistentInputs = {}

      let hasPersistentInputs = false
      for (const key of Object.keys(persistent)) {
        if (!this.addressesToSkip.has(key) && this.knownAddresses.has(key)) {
          hasPersistentInputs = true
          persistentInputs[key] = persistent[key]
          if (preventDuplicateAddresses.has(key)) {
            newAddressesToSkip ??= new Set(this.addressesToSkip)
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

      const result = this.evaluate(payload, start)

      const end = process.hrtime.bigint()

      metrics.durationExt = Number(end - start) / 1e3

      if (typeof result.errorCode === 'number' && result.errorCode < 0) {
        const error = new Error('WAF code error')
        error.errorCode = result.errorCode

        // A later scoped evaluation can fail after the parent produced useful
        // output. Preserve that output while reporting the native error.
        if (!result.events?.length && isEmpty(result.actions) && isEmpty(result.attributes)) throw error
        log.error('[ASM] Error while running the AppSec WAF', error)
        metrics.errorCode = result.errorCode
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

      metrics.duration = (result.duration || 0) / 1e3
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
        wafRunFinished.publish({ payload })
      }

      Reporter.reportMetrics(metrics, raspRule, req, rootSpan)
    }
  }

  /**
   * @param {{ persistent?: object, ephemeral?: object }} payload - Filtered address maps.
   * @param {bigint} start - Start of the combined evaluation in monotonic nanoseconds.
   */
  evaluate (payload, start) {
    if (!this.useSubcontexts) return this.ddwafContext.run(payload, this.wafTimeout)

    let result
    if (payload.persistent) {
      result = this.ddwafContext.run(payload.persistent, this.wafTimeout)
      if (!payload.ephemeral || result.errorCode < 0 || result.timeout || getBlockingAction(result.actions)) {
        return result
      }
    }

    let subcontext
    try {
      subcontext = this.ddwafContext.createSubcontext()
      const remaining = result
        ? Math.floor(this.wafTimeout - Number(process.hrtime.bigint() - start) / 1e3)
        : this.wafTimeout
      if (remaining <= 0) {
        result.timeout = true
        return result
      }
      const scopedResult = subcontext.run(payload.ephemeral, remaining)
      return result ? combineResults(result, scopedResult) : scopedResult
    } catch (error) {
      if (!result) throw error
      log.error('[ASM] Error while running the scoped AppSec WAF', error)
      result.errorCode = error.errorCode ?? -127
      return result
    } finally {
      subcontext?.dispose()
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

/**
 * @param {object} persistent - Result of the parent evaluation.
 * @param {object} scoped - Result of the scoped evaluation, applied second.
 */
function combineResults (persistent, scoped) {
  const metrics = { ...persistent.metrics }
  if (scoped.metrics) {
    for (const key of ['maxTruncatedString', 'maxTruncatedContainerSize', 'maxTruncatedContainerDepth']) {
      if (scoped.metrics[key]) metrics[key] = Math.max(metrics[key] || 0, scoped.metrics[key])
    }
  }

  return {
    ...persistent,
    ...scoped,
    duration: (persistent.duration || 0) + (scoped.duration || 0),
    timeout: !!(persistent.timeout || scoped.timeout),
    keep: !!(persistent.keep || scoped.keep),
    evaluated: (persistent.evaluated || 0) + (scoped.evaluated || 0),
    events: [...(persistent.events || []), ...(scoped.events || [])],
    actions: { ...persistent.actions, ...scoped.actions },
    attributes: { ...persistent.attributes, ...scoped.attributes },
    metrics,
  }
}

module.exports = WAFContextWrapper
