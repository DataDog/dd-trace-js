'use strict'

const { SVC_SRC_KEY } = require('../constants')

/**
 * Symbol used to mark a span with the service name an integration intends to
 * claim. Written by {@link TracingPlugin#stampIntegrationService} (and
 * {@link TracingPlugin#setServiceName}) and read at finish time by
 * {@link resolveServiceSource} to detect whether the current `service.name`
 * was overridden by user code.
 */
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
 * - no marker but svc_src already exists → preserve legacy integration
 *   attribution from callers that set both tags directly
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

  if (marker === currentService || (marker === undefined && existingSource !== undefined)) {
    return
  }

  tags[SVC_SRC_KEY] = MANUAL
}

module.exports = {
  INTEGRATION_SERVICE,
  MANUAL,
  resolveServiceSource,
}
