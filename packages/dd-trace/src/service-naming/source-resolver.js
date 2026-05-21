'use strict'

const { SVC_SRC_KEY } = require('../constants')

const INTEGRATION_SERVICE = Symbol('dd.integrationService')
const MANUAL = 'm'

/**
 * Reconcile `_dd.svc_src` against the span's final `service.name`. Called from
 * `Span#finish` once all writes are in.
 *
 * Rules:
 * - no marker AND service.name equals the tracer default AND no svc_src set →
 *   nothing to reconcile (fast path)
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
  const tags = span._spanContext._tags
  const currentService = tags['service.name']
  const existingSource = tags[SVC_SRC_KEY]

  if (currentService === tracerService) {
    if (existingSource === undefined) return
    delete tags[SVC_SRC_KEY]
    return
  }

  const marker = span[INTEGRATION_SERVICE]

  if (marker === currentService) {
    return
  }

  tags[SVC_SRC_KEY] = MANUAL
}

module.exports = {
  INTEGRATION_SERVICE,
  MANUAL,
  resolveServiceSource,
}
