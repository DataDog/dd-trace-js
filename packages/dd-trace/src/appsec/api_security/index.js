'use strict'

const web = require('../../plugins/util/web')
const { isSchemaAttribute } = require('../reporter')
const appsecTelemetry = require('../telemetry')
const sampler = require('./sampler')

/**
 * Map a sampling decision into the corresponding API Security telemetry metric.
 *
 * The decision is done by the sampler, here the outcome is translated to emitted metrics:
 *   - SAMPLE: request.schema / request.no_schema depending on WAF schema attributes
 *   - MISSING_ROUTE: missing_route
 *   - SKIP: no metric emitted
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {'sample' | 'missing_route' | 'skip'} samplingDecision Sampler decission
 * @param {{ attributes?: Record<string, unknown> } | undefined} wafResult WAF run result
 */
function reportRequest (req, res, samplingDecision, wafResult) {
  switch (samplingDecision) {
    case sampler.SamplingDecision.SAMPLE: {
      const framework = getFramework(req)
      if (hasSchemaAttributes(wafResult?.attributes)) {
        appsecTelemetry.incrementApiSecRequestSchemaMetric(framework)
      } else {
        appsecTelemetry.incrementApiSecRequestNoSchemaMetric(framework)
      }
      break
    }
    case sampler.SamplingDecision.MISSING_ROUTE:
      appsecTelemetry.incrementApiSecMissingRouteMetric(getFramework(req))
      break
  }
}

function getFramework (req) {
  return web.root(req)?.context()?._tags?.component
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
  reportRequest,
  SamplingDecision: sampler.SamplingDecision,
}
