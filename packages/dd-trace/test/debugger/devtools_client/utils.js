'use strict'

const { randomUUID } = require('node:crypto')

module.exports = {
  generateProbeConfig,
  getRequestOptions,
}

/**
 * @typedef {object} RequestOptions
 * @property {string} method
 * @property {string} path
 */

/**
 * @typedef {object} ProbeConfig
 * @property {string} id
 * @property {number} version
 * @property {'LOG_PROBE'} type
 * @property {'javascript'} language
 * @property {{ sourceFile: string, lines: string[] }} where
 * @property {string[]} tags
 * @property {string} template
 * @property {Array<{ str: string } | { dsl: string, json: object }>} segments
 * @property {boolean} captureSnapshot
 * @property {'EXIT'} evaluateAt
 * @property {{
 *   maxReferenceDepth?: number,
 *   maxCollectionSize?: number,
 *   maxFieldCount?: number,
 *   maxLength?: number
 * }} [capture]
 * @property {{ snapshotsPerSecond?: number }} [sampling]
 */

/**
 * @typedef {Pick<import('../../../../../integration-tests/debugger/utils').BreakpointInfo, 'sourceFile' | 'line'>}
 *   BreakpointForProbeConfig
 */

/**
 * Generate a probe config for a breakpoint
 *
 * @param {BreakpointForProbeConfig} breakpoint - The breakpoint to generate a probe config for. Only `sourceFile` and
 *   `line` are required.
 * @param {Partial<ProbeConfig>} [overrides] - The overrides to apply to the probe config.
 * @returns {ProbeConfig} - The probe config.
 */
function generateProbeConfig (breakpoint, overrides = {}) {
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
    ...overrides,
    capture: { maxReferenceDepth: 3, ...overrides.capture },
    sampling: { snapshotsPerSecond: 5000, ...overrides.sampling },
  }
}

/**
 * Get the request options from a request spy call
 *
 * @param {sinon.SinonSpy} request - The request spy to get the options from.
 * @returns {RequestOptions} - The 2nd argument to the `request` function (i.e. the request options).
 */
function getRequestOptions (request) {
  return request.lastCall.args[1]
}
