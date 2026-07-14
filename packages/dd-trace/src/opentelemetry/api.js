'use strict'

const api = require('@opentelemetry/api')
const apiLogs = require('@opentelemetry/api-logs')

const satisfies = require('../../../../vendor/dist/semifies')
const log = require('../log')

const API_VERSION_RANGE = '>=1.4.1 <1.10.0'
const API_OWNER_VERSION = require('../../../../package.json').dependencies['@opentelemetry/api']

/**
 * Moves diagnostic-only state to the pinned API version before it owns a signal.
 *
 * OpenTelemetry requires every signal registration to use the exact version that created the
 * global. An older application copy can create that global by configuring diagnostics alone,
 * even though a newer owner would otherwise be backwards compatible.
 *
 * @returns {void}
 */
function prepareApiOwner () {
  const globalKey = Symbol.for('opentelemetry.js.api.1')

  try {
    const globalApi = Reflect.get(globalThis, globalKey)
    if (!globalApi || typeof globalApi !== 'object' || globalApi.version === API_OWNER_VERSION) return
    if (typeof globalApi.version !== 'string' || !satisfies(globalApi.version, API_VERSION_RANGE)) return

    for (const key of Reflect.ownKeys(globalApi)) {
      if (key !== 'version' && key !== 'diag') return
    }

    const ownerGlobal = { ...globalApi, version: API_OWNER_VERSION }
    if (!Reflect.set(globalThis, globalKey, ownerGlobal)) {
      log.error('Unable to prepare the OpenTelemetry API global owner.')
    }
  } catch (error) {
    log.error('Unable to prepare the OpenTelemetry API global owner: %s', error)
  }
}

/**
 * Returns the pinned OpenTelemetry API used by bridge internals.
 *
 * @returns {typeof import('@opentelemetry/api')}
 */
function getApi () {
  return api
}

/**
 * Returns the pinned OpenTelemetry Logs API used by bridge internals.
 *
 * @returns {typeof import('@opentelemetry/api-logs')}
 */
function getApiLogs () {
  return apiLogs
}

/**
 * Returns the pinned API after making it safe to register global signal providers.
 *
 * @returns {typeof import('@opentelemetry/api')}
 */
function getApiOwner () {
  prepareApiOwner()
  return api
}

module.exports = {
  getApi,
  getApiLogs,
  getApiOwner,
}
