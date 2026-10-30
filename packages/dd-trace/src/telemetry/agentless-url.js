'use strict'

const { createSiteUrl } = require('../exporters/common/url')

const STAGING_SITE = 'datad0g.com'

let cachedSite
let cachedUrl

/**
 * @param {string} site
 * @returns {URL}
 */
function getAgentlessTelemetryUrl (site) {
  if (site === cachedSite && cachedUrl !== undefined) return cachedUrl

  const intake = site === STAGING_SITE
    ? 'all-http-intake.logs'
    : 'instrumentation-telemetry-intake'
  const url = createSiteUrl(site, intake)
  if (url === undefined) throw new Error(`Invalid DD_SITE for agentless telemetry: ${site}`)

  cachedSite = site
  cachedUrl = url
  return url
}

module.exports = getAgentlessTelemetryUrl
