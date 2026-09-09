'use strict'

const web = require('../../plugins/util/web')
const { isSchemaAttribute } = require('../reporter')
const appsecTelemetry = require('../telemetry')
const sampler = require('./sampler')

/** @typedef {import('../../opentracing/span')} DatadogSpan */

/**
 * Map a sampling decision into the corresponding API Security telemetry metric.
 *
 * The decision is done by the sampler, here the outcome is translated to emitted metrics:
 *   - SAMPLE: request.schema / request.no_schema depending on WAF schema attributes
 *   - MISSING_ROUTE: missing_route
 *   - SKIP: no metric emitted
 *
 * @param {DatadogSpan} rootSpan Span the sampling decision was attached to
 * @param {'sample' | 'missing_route' | 'skip'} samplingDecision Sampler decision
 * @param {{ attributes?: Record<string, unknown> } | undefined} wafResult WAF run result
 */
function reportRootSpanRequest (rootSpan, samplingDecision, wafResult) {
  switch (samplingDecision) {
    case sampler.SamplingDecision.SAMPLE: {
      const framework = getFramework(rootSpan)
      if (hasSchemaAttributes(wafResult?.attributes)) {
        appsecTelemetry.incrementApiSecRequestSchemaMetric(framework)
      } else {
        appsecTelemetry.incrementApiSecRequestNoSchemaMetric(framework)
      }
      break
    }
    case sampler.SamplingDecision.MISSING_ROUTE:
      appsecTelemetry.incrementApiSecMissingRouteMetric(getFramework(rootSpan))
      break
  }
}

/**
 * Node HTTP adapter over {@link reportRootSpanRequest}.
 *
 * @param {import('http').IncomingMessage} req
 * @param {'sample' | 'missing_route' | 'skip'} samplingDecision Sampler decision
 * @param {{ attributes?: Record<string, unknown> } | undefined} wafResult WAF run result
 */
function reportRequest (req, samplingDecision, wafResult) {
  if (samplingDecision === sampler.SamplingDecision.SKIP) return

  reportRootSpanRequest(web.root(req), samplingDecision, wafResult)
}

function getFramework (rootSpan) {
  return rootSpan?.context?.()?.getTag?.('component')
}

function hasSchemaAttributes (attributes) {
  if (!attributes) return false
  for (const key of Object.keys(attributes)) {
    if (isSchemaAttribute(key)) return true
  }
  return false
}

module.exports = {
  configure: sampler.configure,
  disable: sampler.disable,
  sampleRequest: sampler.sampleRequest,
  sampleRootSpanRequest: sampler.sampleRootSpanRequest,
  reportRequest,
  reportRootSpanRequest,
  SamplingDecision: sampler.SamplingDecision,
}
