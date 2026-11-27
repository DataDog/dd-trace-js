'use strict'

const { HTTP_ROUTE, RESOURCE_NAME } = require('../../../ext/tags')
const {
  INSTRUMENTATION_HTTP_RESOURCE,
  isInstrumentationOwnedResource,
  otelHttpResourceName,
} = require('./plugins/util/http-otel-semantics')

const PUBLISHED_ROUTE = Symbol('published route')
const ROUTING_SELECTION = Symbol('routing selection')

/** @typedef {import('./opentracing/span_context')} DatadogSpanContext */
/**
 * @typedef {'' | false | typeof PUBLISHED_ROUTE} SamplingRoute
 * @typedef {(displayedRoute: string | undefined, source: HttpResourceSource) => string | false | undefined}
 *   ReadSamplingRoute
 * @typedef {{
 *   readSamplingRoute: ReadSamplingRoute,
 *   getProvisionalRoute?: (paths: string[]) => string | undefined,
 * }} RouteReader
 * @typedef {{
 *   req: { method: string },
 *   config: { DD_TRACE_OTEL_SEMANTICS_ENABLED?: boolean },
 *   paths: string[],
 *   samplingRoute?: SamplingRoute,
 *   samplingRouteReader?: RouteReader,
 *   generatedRoute?: string,
 * }} HttpResourceSource
 */

/** @type {WeakMap<DatadogSpanContext, WeakRef<HttpResourceSource>> | undefined} */
let sources

/**
 * @param {DatadogSpanContext} context
 * @param {HttpResourceSource} source
 */
function trackSamplingContext (context, source) {
  sources ??= new WeakMap()
  sources.set(context, new WeakRef(source))
}

/**
 * @param {string} method
 * @param {string} [route]
 */
function httpResourceName (method, route) {
  return route ? method + ' ' + route : method
}

/** @param {string[]} paths */
function joinRoute (paths) {
  return paths.length > 1 ? paths.join('') : paths[0]
}

/** @param {string | false | undefined} route */
function normalizeRouteSegment (route) {
  return !route || route === '/' || route === '*' ? '' : route
}

/** @param {DatadogSpanContext} context */
function getSamplingResource (context) {
  const resource = context.getTag(RESOURCE_NAME)
  const source = sources?.get(context)?.deref()
  if (!source?.samplingRouteReader) return resource

  const { paths, req, config, generatedRoute, samplingRoute, samplingRouteReader } = source
  const otel = config.DD_TRACE_OTEL_SEMANTICS_ENABLED
  if (resource && (!otel || !isInstrumentationOwnedResource(resource, context.getTag(INSTRUMENTATION_HTTP_RESOURCE)))) {
    return resource
  }

  const taggedRoute = context.getTag(HTTP_ROUTE)
  const displayedRoute = samplingRoute !== undefined && (otel || context.hasTag(HTTP_ROUTE))
    ? taggedRoute
    : joinRoute(paths)
  const route = typeof taggedRoute === 'string' && taggedRoute !== generatedRoute
    ? taggedRoute
    : samplingRouteReader.readSamplingRoute(displayedRoute, source)

  if (route === false) return
  if (route === undefined) return resource
  return otel ? otelHttpResourceName(req.method, route) : httpResourceName(req.method, route)
}

module.exports = {
  PUBLISHED_ROUTE,
  ROUTING_SELECTION,
  getSamplingResource,
  httpResourceName,
  joinRoute,
  normalizeRouteSegment,
  trackSamplingContext,
}
