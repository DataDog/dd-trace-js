'use strict'

const { MANUAL_KEEP } = require('../../../../../ext/tags')
const LRU = require('lru-cache')
const vulnerabilitiesFormatter = require('./vulnerabilities-formatter')
const { IAST_ENABLED_TAG_KEY, IAST_JSON_TAG_KEY } = require('./tags')

const VULNERABILITIES_KEY = 'vulnerabilities'
const VULNERABILITY_HASHES_MAX_SIZE = 1000
const VULNERABILITY_HASHES = new LRU({ max: VULNERABILITY_HASHES_MAX_SIZE })
const RESET_VULNERABILITY_CACHE_INTERVAL = 60 * 60 * 1000 // 1 hour

let tracer
let resetVulnerabilityCacheTimer
let deduplicationEnabled = true

function addVulnerability (iastContext, vulnerability) {
  if (vulnerability && vulnerability.evidence && vulnerability.type &&
    vulnerability.location) {
    if (iastContext && iastContext.rootSpan) {
      iastContext[VULNERABILITIES_KEY] = iastContext[VULNERABILITIES_KEY] || []
      iastContext[VULNERABILITIES_KEY].push(vulnerability)
    } else {
      sendVulnerabilities([vulnerability])
    }
  }
}

function isValidVulnerability (vulnerability) {
  return vulnerability && vulnerability.type &&
    vulnerability.evidence &&
    vulnerability.location && vulnerability.location.spanId
}

function sendVulnerabilities (vulnerabilities, rootSpan) {
  if (vulnerabilities && vulnerabilities.length) {
    let span = rootSpan
    if (!span && tracer) {
      span = tracer.startSpan('vulnerability', {
        type: 'vulnerability'
      })
      vulnerabilities.forEach((vulnerability) => {
        vulnerability.location.spanId = span.context().toSpanId()
      })
      span.addTags({
        [IAST_ENABLED_TAG_KEY]: 1
      })
    }

    if (span && span.addTags) {
      const validAndDedupVulnerabilities = deduplicateVulnerabilities(vulnerabilities).filter(isValidVulnerability)
      const jsonToSend = vulnerabilitiesFormatter.toJson(validAndDedupVulnerabilities)

      if (jsonToSend.vulnerabilities.length > 0) {
        const tags = {}
        // TODO: Store this outside of the span and set the tag in the exporter.
        tags[IAST_JSON_TAG_KEY] = JSON.stringify(jsonToSend)
        tags[MANUAL_KEEP] = 'true'
        span.addTags(tags)
        if (!rootSpan) span.finish()
      }
    }
  }
  return IAST_JSON_TAG_KEY
}

function clearCache () { // only for test purposes
  VULNERABILITY_HASHES.clear()
}

function startClearCacheTimer () {
  resetVulnerabilityCacheTimer = setInterval(clearCache, RESET_VULNERABILITY_CACHE_INTERVAL)
  resetVulnerabilityCacheTimer.unref()
}

function stopClearCacheTimer () {
  if (resetVulnerabilityCacheTimer) {
    clearInterval(resetVulnerabilityCacheTimer)
    resetVulnerabilityCacheTimer = null
  }
}

function deduplicateVulnerabilities (vulnerabilities) {
  if (!deduplicationEnabled) return vulnerabilities
  const deduplicated = vulnerabilities.filter((vulnerability) => {
    const key = `${vulnerability.type}${vulnerability.hash}`
    if (!VULNERABILITY_HASHES.get(key)) {
      VULNERABILITY_HASHES.set(key, true)
      return true
    }
    return false
  })
  return deduplicated
}

function start (config, _tracer) {
  deduplicationEnabled = config.iast.deduplicationEnabled
  vulnerabilitiesFormatter.setRedactVulnerabilities(
    config.iast.redactionEnabled,
    config.iast.redactionNamePattern,
    config.iast.redactionValuePattern
  )
  if (deduplicationEnabled) {
    startClearCacheTimer()
  }
  tracer = _tracer
}

function stop () {
  stopClearCacheTimer()
}

module.exports = {
  addVulnerability,
  sendVulnerabilities,
  clearCache,
  start,
  stop
}
