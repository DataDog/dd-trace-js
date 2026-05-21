'use strict'

const web = require('../../plugins/util/web')
const { isBlocked } = require('../blocking')
const { isSchemaAttribute } = require('../reporter')
const appsecTelemetry = require('../telemetry')
const sampler = require('./sampler')

function reportRequest (req, res, { sampled, wafResult }) {
  if (!sampler.isEnabled()) return
  if (res.statusCode === 404 || isBlocked(res)) return

  if (!sampler.hasRoute(req, res)) {
    appsecTelemetry.incrementApiSecMissingRouteMetric(getFramework(req))
    return
  }

  if (!sampled) return

  const framework = getFramework(req)
  if (hasSchemaAttributes(wafResult?.attributes)) {
    appsecTelemetry.incrementApiSecRequestSchemaMetric(framework)
  } else {
    appsecTelemetry.incrementApiSecRequestNoSchemaMetric(framework)
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
}
