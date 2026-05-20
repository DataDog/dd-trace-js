'use strict'

const { SVC_SRC_KEY } = require('../constants')

const INTEGRATION_SERVICE = Symbol('dd.integrationService')
const MANUAL = 'm'

/**
 * Stamp the integration's intended `service.name` on a span. Read at finish
 * time by {@link resolveServiceSource} to detect whether the current
 * `service.name` was overridden by user code (and should be marked manual).
 *
 * No-op when there is nothing meaningful to record — either no claim was made,
 * or the claim is indistinguishable from the tracer's default service.
 *
 * @param {object} span Internal DatadogSpan instance.
 * @param {string|undefined} name Service name the integration is claiming.
 * @param {string|undefined} tracerService The tracer's configured default service.
 */
function stampIntegrationService (span, name, tracerService) {
  if (name === undefined || name === tracerService) return
  span[INTEGRATION_SERVICE] = name
}

/**
 * Set `service.name` on a span on behalf of an integration after span start.
 * Use this for late-binding cases where the service is not known at startSpan
 * time (e.g. web framework config applied after the span is already open).
 *
 * For spans started via {@link TracingPlugin#startSpan}, pass `service` as an
 * option instead — it sets the tag and stamps the marker in one step.
 *
 * @param {object} span Internal DatadogSpan instance.
 * @param {string} name Service name the integration is claiming.
 * @param {string|undefined} tracerService The tracer's configured default service.
 */
function setServiceName (span, name, tracerService) {
  span._spanContext._tags['service.name'] = name
  stampIntegrationService(span, name, tracerService)
}

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
  const marker = span[INTEGRATION_SERVICE]

  if (marker === undefined && currentService === tracerService && tags[SVC_SRC_KEY] === undefined) {
    return
  }

  if (currentService === tracerService) {
    delete tags[SVC_SRC_KEY]
    return
  }

  if (marker === currentService || (marker === undefined && tags[SVC_SRC_KEY] !== undefined)) {
    return
  }

  tags[SVC_SRC_KEY] = MANUAL
}

module.exports = {
  INTEGRATION_SERVICE,
  MANUAL,
  setServiceName,
  stampIntegrationService,
  resolveServiceSource,
}
