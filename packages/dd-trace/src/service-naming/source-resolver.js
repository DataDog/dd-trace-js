'use strict'

const { SVC_SRC_KEY } = require('../constants')
const eventWriter = require('../opentracing/event-writer')

const integrationServices = new WeakMap()
const MANUAL = 'm'

/**
 * Record the service name claimed by an integration without attaching state to the span.
 *
 * @param {object} span
 * @param {string} service
 */
function setIntegrationService (span, service) {
  integrationServices.set(span, service)
}

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
  const marker = integrationServices.get(span)
  eventWriter.resolveServiceSource(span, tracerService, marker, SVC_SRC_KEY, MANUAL)
}

module.exports = {
  MANUAL,
  resolveServiceSource,
  setIntegrationService,
}
