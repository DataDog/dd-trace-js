'use strict'

const { SVC_SRC_KEY } = require('../constants')

const INTEGRATION_SERVICE = Symbol('dd.integrationService')
const MANUAL = 'm'

/**
 * Stamp the integration's intended `service.name` on a span. Read at finish
 * time by {@link resolveServiceSource} to detect whether the current
 * `service.name` was overridden by user code (and should be marked manual).
 *
 * @param {object} span Internal DatadogSpan instance.
 * @param {string} name Service name the integration is claiming for this span.
 */
function stampIntegrationService (span, name) {
  span[INTEGRATION_SERVICE] = name
}

/**
 * Reconcile `_dd.svc_src` against the span's final `service.name`. Called from
 * `Span#finish` once all writes are in.
 *
 * Rules:
 * - service.name equals the tracer's default service → no manual marker
 *   (and clear any source the integration stamped early)
 * - integration marker exists and equals current service.name → integration
 *   owns the value; leave the source label the integration set
 * - otherwise → user wrote (no marker) or overrode the integration value;
 *   stamp 'm'
 *
 * @param {object} span Internal DatadogSpan instance.
 * @param {string} tracerService The tracer's configured default service.
 */
function resolveServiceSource (span, tracerService) {
  const tags = span._spanContext._tags
  const currentService = tags['service.name']

  if (currentService === tracerService) {
    delete tags[SVC_SRC_KEY]
    return
  }

  const marker = span[INTEGRATION_SERVICE]
  if (marker !== undefined && marker === currentService) {
    return
  }

  tags[SVC_SRC_KEY] = MANUAL
}

module.exports = {
  INTEGRATION_SERVICE,
  MANUAL,
  stampIntegrationService,
  resolveServiceSource,
}
