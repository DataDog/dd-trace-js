'use strict'

const path = require('path')

function normalizeRequests (requests) {
  const events = []
  for (const request of requests) {
    if (!request.url || !request.url.endsWith('/api/v2/citestcycle')) continue
    const payloadEvents = request.payload && Array.isArray(request.payload.events) ? request.payload.events : []
    for (const event of payloadEvents) {
      events.push(normalizeEvent(event, request))
    }
  }
  return events
}

function normalizeEvent (event, request) {
  const content = event.content || {}
  const meta = content.meta || {}
  const metrics = content.metrics || {}
  return {
    type: event.type,
    requestUrl: request.url,
    name: content.name,
    resource: content.resource,
    service: content.service,
    error: content.error,
    meta,
    metrics,
    testName: meta['test.name'],
    testSuite: meta['test.suite'],
    testStatus: meta['test.status'],
    testSourceFile: meta['test.source.file'],
    retryReason: meta['test.retry_reason'],
    isRetry: meta['test.is_retry'] === 'true' || metrics['test.is_retry'] === 1,
    earlyFlakeEnabled: meta['test.early_flake.enabled'] === 'true',
    testManagementEnabled: meta['test.test_management.enabled'] === 'true',
    isQuarantined: meta['test.test_management.is_quarantined'] === 'true',
    isDisabled: meta['test.test_management.is_test_disabled'] === 'true',
    isAttemptToFix: meta['test.test_management.is_attempt_to_fix'] === 'true',
  }
}

function eventsOfType (events, type) {
  return events.filter(event => event.type === type)
}

function findTestsByIdentity (events, identities) {
  const tests = eventsOfType(events, 'test')
  return tests.filter(test => identities.some(identity => matchesIdentity(test, identity)))
}

function matchesIdentity (test, identity) {
  if (identity.name && !sameOrEndsWith(test.testName, identity.name)) return false
  if (identity.file && test.testSourceFile && sameOrEndsWith(test.testSourceFile, identity.file)) return true
  if (identity.suite && test.testSuite && sameOrEndsWith(test.testSuite, identity.suite)) return true
  return Boolean(identity.name)
}

function sameOrEndsWith (actual, expected) {
  if (!actual || !expected) return false
  return actual === expected ||
    actual.endsWith(expected) ||
    expected.endsWith(actual) ||
    path.basename(actual) === path.basename(expected)
}

module.exports = {
  normalizeRequests,
  eventsOfType,
  findTestsByIdentity,
}
