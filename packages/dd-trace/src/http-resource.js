'use strict'

const { HTTP_ROUTE, RESOURCE_NAME } = require('../../../ext/tags')
const {
  INSTRUMENTATION_HTTP_RESOURCE,
  isInstrumentationOwnedResource,
  otelHttpResourceName,
} = require('./plugins/util/http-otel-semantics')

/** @typedef {import('./opentracing/span_context')} DatadogSpanContext */
/** @typedef {{ readSamplingRoute: (displayedRoute: string | undefined) => string | false | undefined }} RouteReader */
/**
 * @typedef {{
 *   req: { method: string },
 *   config: { DD_TRACE_OTEL_SEMANTICS_ENABLED?: boolean },
 *   paths: string[],
 *   generatedRoute?: string,
 *   samplingRouteReader?: RouteReader,
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

  const { config, generatedRoute, paths, req, samplingRouteReader } = source
  const otel = config.DD_TRACE_OTEL_SEMANTICS_ENABLED
  if (resource && (!otel || !isInstrumentationOwnedResource(resource, context.getTag(INSTRUMENTATION_HTTP_RESOURCE)))) {
    return resource
  }

  const taggedRoute = context.getTag(HTTP_ROUTE)
  const route = typeof taggedRoute === 'string' && taggedRoute !== generatedRoute
    ? taggedRoute
    : samplingRouteReader.readSamplingRoute(joinRoute(paths))

  if (route === false) return
  if (route === undefined) return resource
  return otel ? otelHttpResourceName(req.method, route) : httpResourceName(req.method, route)
}

module.exports = { getSamplingResource, httpResourceName, joinRoute, normalizeRouteSegment, trackSamplingContext }
