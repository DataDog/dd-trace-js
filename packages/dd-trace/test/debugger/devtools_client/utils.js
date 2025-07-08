'use strict'

const { randomUUID } = require('node:crypto')

module.exports = {
  generateProbeConfig,
  getRequestOptions
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
