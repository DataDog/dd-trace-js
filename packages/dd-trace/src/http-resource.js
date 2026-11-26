'use strict'

const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME } = require('../../../ext/tags')
const {
  INSTRUMENTATION_HTTP_RESOURCE,
  isInstrumentationOwnedResource,
  otelHttpResourceName,
} = require('./plugins/util/http-otel-semantics')

/** @type {WeakMap<DatadogSpanContext, WeakRef<HttpResourceSource>>} */
const resourceSources = new WeakMap()

/**
 * @typedef {import('./opentracing/span_context')} DatadogSpanContext
 * @typedef {{ method: string }} HttpRequest
 * @typedef {(req: HttpRequest, displayedRoute: string | undefined) => string | undefined} RouteReader
 * @typedef {{ active: boolean }} RouteActivity
 * @typedef {{ activity: RouteActivity, template: string, previous: SamplingRoute | undefined }} ScopedRoute
 * @typedef {string | false | RouteReader | ScopedRoute} SamplingRoute
 * @typedef {{
 *   req: HttpRequest,
 *   config: { DD_TRACE_OTEL_SEMANTICS_ENABLED?: boolean },
 *   samplingRoute: SamplingRoute | undefined,
 *   generatedRoute?: string,
 *   paths: string[],
 * }} HttpResourceSource
 */

/**
 * @param {string} method
 * @param {string} [route]
 * @param {boolean} [otelSemanticsEnabled]
 */
function httpResourceName (method, route, otelSemanticsEnabled) {
  if (otelSemanticsEnabled) return otelHttpResourceName(method, route)
  return route ? `${method} ${route}` : method
}

/**
 * @param {string[]} paths
 */
function joinRoute (paths) {
  return paths.length > 1 ? paths.join('') : paths[0]
}

/**
 * @template {string | RegExp} Route
 * @param {Route | false | undefined} route
 */
function normalizeRouteSegment (route) {
  return !route || route === '/' || route === '*' ? '' : route
}

/**
 * @param {SamplingRoute | undefined} route
 */
function liveSamplingRoute (route) {
  while (route && typeof route === 'object' && !route.activity.active) route = route.previous
  return route
}

/**
 * @param {DatadogSpanContext} context
 * @param {HttpResourceSource} requestContext
 */
function trackSamplingContext (context, requestContext) {
  resourceSources.set(context, new WeakRef(requestContext))
}

/**
 * @param {DatadogSpanContext} context
 */
function untrackSamplingContext (context) {
  resourceSources.delete(context)
}

/**
 * @param {DatadogSpanContext} context
 */
function getSamplingResource (context) {
  const resource = context.getTag(RESOURCE_NAME)
  const requestContext = resourceSources.get(context)?.deref()
  if (!requestContext) return resource

  const { req, config, samplingRoute, generatedRoute } = requestContext
  const otel = config.DD_TRACE_OTEL_SEMANTICS_ENABLED
  if (resource && (!otel || !isInstrumentationOwnedResource(resource, context.getTag(INSTRUMENTATION_HTTP_RESOURCE)))) {
    return resource
  }

  const taggedRoute = context.getTag(HTTP_ROUTE)
  const route = typeof taggedRoute === 'string' && taggedRoute !== generatedRoute
    ? taggedRoute
    : liveSamplingRoute(samplingRoute)
  let template
  if (route && typeof route === 'object') {
    template = route.template
  } else if (typeof route === 'function') {
    template = route(req, joinRoute(requestContext.paths))
  } else {
    template = route
  }
  if (template === undefined) {
    return resource && taggedRoute === undefined && !joinRoute(requestContext.paths) ? resource : undefined
  }

  const methodTag = otel ? context.getTag(HTTP_METHOD) : undefined
  return httpResourceName(typeof methodTag === 'string' ? methodTag : req.method, template || undefined, otel)
}

module.exports = {
  getSamplingResource,
  httpResourceName,
  joinRoute,
  liveSamplingRoute,
  normalizeRouteSegment,
  trackSamplingContext,
  untrackSamplingContext,
}
