'use strict'

const { randomUUID } = require('node:crypto')

module.exports = {
  expectWithin,
  generateProbeConfig,
  getRequestOptions
}

function expectWithin (timeout, fn, start = Date.now(), backoff = 1) {
  try {
    fn()
  } catch (e) {
    if (Date.now() - start > timeout) {
      throw e
    } else {
      setTimeout(expectWithin, backoff, timeout, fn, start, backoff < 128 ? backoff * 2 : backoff)
    }
  }
}

function generateProbeConfig (breakpoint, overrides = {}) {
  overrides.capture = { maxReferenceDepth: 3, ...overrides.capture }
  overrides.sampling = { snapshotsPerSecond: 5000, ...overrides.sampling }
  return {
    id: randomUUID(),
    version: 0,
    type: 'LOG_PROBE',
    language: 'javascript',
    where: { sourceFile: breakpoint.sourceFile, lines: [String(breakpoint.line)] },
    tags: [],
    template: 'Hello World!',
    segments: [{ str: 'Hello World!' }],
    captureSnapshot: false,
    evaluateAt: 'EXIT',
    ...overrides
  }
}

function getRequestOptions (request) {
  return request.lastCall.args[1]
}
