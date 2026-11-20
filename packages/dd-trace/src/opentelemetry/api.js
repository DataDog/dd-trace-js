'use strict'

const { createRequire } = require('node:module')
const { dirname, parse, resolve } = require('node:path')

const satisfies = require('../../../../vendor/dist/semifies')

const instrumentation = require('../../../datadog-instrumentations/src/otel-api')
const getConfig = require('../config')
const { findUp } = /** @type {{ findUp(name: string, root: string, directory: string): string | undefined }} */ (
  require('../pkg')
)

const { apis, captureApi } = instrumentation
const registryKey = Symbol.for('opentelemetry.js.api.1')

/**
 * @param {ReturnType<typeof createRequire>} from
 * @param {string} [specifier]
 */
function loadApiFrom (from, specifier = '@opentelemetry/api') {
  let filename
  try {
    filename = from.resolve(specifier)
  } catch (error) {
    if (specifier !== '@opentelemetry/api' || error.code !== 'MODULE_NOT_FOUND' ||
        !error.message.startsWith("Cannot find module '@opentelemetry/api'")) throw error
  }
  if (filename) {
    const api = from(specifier)
    if (!apis.has(api)) {
      const packageFile = findUp('package.json', parse(filename).root, dirname(filename))
      captureApi(api, require(/** @type {string} */ (packageFile)).version)
    }
    return api
  }
}

function loadApi () {
  const entry = require.main?.filename ?? resolve(process.argv[1] ?? 'package.json')
  const from = createRequire(entry)
  const apiPath = getConfig().otelApiPath
  const preferredApi = apiPath ? loadApiFrom(from, apiPath) : undefined
  const applicationApi = loadApiFrom(from)
  loadApiFrom(require)
  const registryVersion = globalThis[registryKey]?.version
  let latestApi
  let latestVersion
  let registeredApi

  for (const [api, { version }] of apis) {
    if (version === registryVersion && (!registeredApi || api === applicationApi)) registeredApi = api
    if (satisfies(version, '^1.0.0') &&
        (!latestApi || satisfies(version, `>${latestVersion}`) ||
          (version === latestVersion && api === applicationApi))) {
      latestApi = api
      latestVersion = version
    }
  }

  return registeredApi ?? preferredApi ?? applicationApi ?? latestApi ?? require('@opentelemetry/api')
}

// Bridge modules retain this object when another API establishes the registry later.
/** @type {typeof import('@opentelemetry/api')} */
const api = { ...loadApi() }

/**
 * @param {typeof import('@opentelemetry/api')} source
 * @param {string} version
 * @param {string} signal
 * @param {string} method
 * @param {object} provider
 * @param {boolean} registered
 */
instrumentation.onRegistration = function (source, version, signal, method, provider, registered) {
  if (!satisfies(version, '^1.0.0')) return registered

  if (!registered) {
    const registry = globalThis[registryKey]
    if (registry && version !== registry.version && !registry[signal] &&
        provider !== null && (typeof provider === 'object' || typeof provider === 'function')) {
      for (const [candidate, metadata] of apis) {
        if (metadata.version === registry.version) return candidate[signal][method](provider)
      }
    }
    return registered
  }

  Object.assign(api, source)
  if (signal === 'trace') {
    for (const { version, tracerProvider } of apis.values()) {
      if (satisfies(version, '^1.0.0') && tracerProvider !== provider) tracerProvider.setDelegate?.(provider)
    }
  }
  return registered
}

module.exports = api
