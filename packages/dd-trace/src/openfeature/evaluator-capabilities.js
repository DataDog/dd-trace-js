'use strict'

/* eslint-disable n/no-unpublished-require -- The evaluator is bundled into vendor/ for distribution. */

const RemoteConfigCapabilities = require('../remote_config/capabilities')

const DEPENDENT_FLAG_VARIANT_KEY_V1 = 'dependent-flag-variant-key-v1'
const EMPTY_CAPABILITIES = new Set()

const CAPABILITY_TRANSPORTS = new Map([
  [DEPENDENT_FLAG_VARIANT_KEY_V1, {
    originQuery: {
      'cap_dependent-flags-variant-key': 'v1',
    },
    originHeaders: {},
    remoteConfig: RemoteConfigCapabilities.FFE_FLAG_DEPENDENT_FLAG_VARIANT_KEY_V1,
  }],
])

/**
 * Reads the optional evaluator capability contract. Evaluator versions released before this contract report no
 * capabilities.
 *
 * @returns {ReadonlySet<string>}
 */
function getEvaluatorCapabilities () {
  const evaluator = require('../../../../vendor/dist/@datadog/openfeature-node-server')
  if (typeof evaluator.getEvaluatorCapabilities !== 'function') return EMPTY_CAPABILITIES

  try {
    const capabilities = evaluator.getEvaluatorCapabilities()
    return capabilities instanceof Set ? capabilities : EMPTY_CAPABILITIES
  } catch {
    return EMPTY_CAPABILITIES
  }
}

/**
 * Returns the URL and header modifications for requests sent directly to the Feature Flagging origin.
 *
 * @returns {{ query: Record<string, string> | undefined, headers: Record<string, string> }}
 */
function getOriginCapabilities () {
  const query = {}
  const headers = {}
  let hasQuery = false

  for (const id of getEvaluatorCapabilities()) {
    const transport = CAPABILITY_TRANSPORTS.get(id)
    if (transport?.originQuery) {
      Object.assign(query, transport.originQuery)
      hasQuery = true
    }
    if (transport?.originHeaders) Object.assign(headers, transport.originHeaders)
  }

  return { query: hasQuery ? query : undefined, headers }
}

/**
 * Returns Remote Config capability masks supported by the evaluator and tracer integration.
 *
 * @returns {bigint[]}
 */
function getRemoteConfigCapabilities () {
  const capabilities = []

  for (const id of getEvaluatorCapabilities()) {
    const capability = CAPABILITY_TRANSPORTS.get(id)?.remoteConfig
    if (capability !== undefined) capabilities.push(capability)
  }

  return capabilities
}

module.exports = { getOriginCapabilities, getRemoteConfigCapabilities }
