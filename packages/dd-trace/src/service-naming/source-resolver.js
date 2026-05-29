'use strict'

const { SVC_SRC_KEY } = require('../constants')

const INTEGRATION_SERVICE = Symbol('dd.integrationService')
const MANUAL = 'm'

/**
 * Reconcile `_dd.svc_src` against the span's final `service.name`. Called from
 * `Span#finish` once all writes are in.
 *
 * Rules:
 * - service.name equals the tracer default → clear any svc_src
 * - integration marker exists and equals current service.name → integration
 *   owns the value; leave the source label the integration set
 * - otherwise → user wrote (no marker) or overrode the integration value;
 *   stamp 'm'
 *
 * @param {object} span Internal DatadogSpan instance.
 * @param {string|undefined} tracerService The tracer's configured default service.
 */
function resolveServiceSource (span, tracerService) {
  const spanContext = span._spanContext
  const currentService = spanContext.getTag('service.name')
  const existingSource = spanContext.getTag(SVC_SRC_KEY)

  if (currentService === tracerService) {
    if (existingSource === undefined) return
    spanContext.deleteTag(SVC_SRC_KEY)
    return
  }

  const marker = span[INTEGRATION_SERVICE]

  if (marker === currentService) {
    return
  }

  spanContext.setTag(SVC_SRC_KEY, MANUAL)
}

module.exports = {
  INTEGRATION_SERVICE,
  MANUAL,
  resolveServiceSource,
}
