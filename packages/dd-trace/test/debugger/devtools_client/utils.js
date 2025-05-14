'use strict'

const { randomUUID, randomBytes } = require('node:crypto')

module.exports = {
  expectWithin,
  generateProbeConfig,
  getRequestOptions,
  generateObjectWithJSONSizeLargerThan
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

function generateObjectWithJSONSizeLargerThan (targetSize) {
  const obj = {}
  let i = 0
  const largeString = randomBytes(1024).toString('hex')

  while (++i) {
    if (i % 100 === 0) {
      const size = JSON.stringify(obj).length
      if (size > targetSize) break
    }
    obj[i] = largeString
  }

  return obj
}
