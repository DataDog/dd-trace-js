'use strict'

const publicTracerSym = Symbol('dd.publicTracer')

/**
 * Returns the PublicTracer facade associated with an internal tracer, or
 * `undefined` if none has been registered yet.
 *
 * @param {import('../../noop/tracer') | import('../../tracer')} internal
 * @returns {import('./tracer').PublicTracer | undefined}
 */
function getPublicTracer (internal) {
  return internal[publicTracerSym]
}

/**
 * Associates a PublicTracer facade with an internal tracer.
 *
 * @param {import('../../noop/tracer') | import('../../tracer')} internal
 * @param {import('./tracer').PublicTracer} publicTracer
 */
function setPublicTracer (internal, publicTracer) {
  Object.defineProperty(internal, publicTracerSym, {
    value: publicTracer,
    configurable: true,
    writable: true,
  })
}

module.exports = {
  getPublicTracer,
  setPublicTracer,
}
