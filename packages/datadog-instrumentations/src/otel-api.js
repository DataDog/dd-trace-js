'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

/**
 * @type {Map<typeof import('@opentelemetry/api'), {
 *   version: string,
 *   tracerProvider: import('@opentelemetry/api').ProxyTracerProvider
 * }>}
 */
const apis = new Map()

/**
 * @param {typeof import('@opentelemetry/api')} api
 * @param {string} version
 */
function captureApi (api, version) {
  if (!apis.has(api)) {
    apis.set(api, {
      version,
      // Tracers obtained before registration retain this copy's local proxy.
      tracerProvider: /** @type {import('@opentelemetry/api').ProxyTracerProvider} */ (api.trace.getTracerProvider()),
    })
    // API singletons can arrive already evaluated; source rewriting cannot instrument them retroactively.
    for (const [signal, method] of [
      ['trace', 'setGlobalTracerProvider'],
      ['metrics', 'setGlobalMeterProvider'],
      ['context', 'setGlobalContextManager'],
      ['propagation', 'setGlobalPropagator'],
    ]) {
      shimmer.wrap(api[signal], method, register => {
        /** @param {object} provider */
        return function (provider) {
          const registered = register.apply(this, arguments)
          return exports.onRegistration
            ? exports.onRegistration(api, version, signal, method, provider, registered)
            : registered
        }
      })
    }
  }
  return api
}

addHook({ name: '@opentelemetry/api', versions: ['*'], patchDefault: false },
  /** @type {Parameters<typeof addHook>[1]} */ (captureApi))

exports.apis = apis
exports.captureApi = captureApi
/**
 * @typedef {(api: typeof import('@opentelemetry/api'), version: string, signal: string,
 *   method: string, provider: object, registered: boolean) => boolean} RegistrationHandler
 */
exports.onRegistration = /** @type {RegistrationHandler | undefined} */ (undefined)
