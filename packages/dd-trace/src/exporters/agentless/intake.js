'use strict'

const { createSiteUrl } = require('../common/url')

// Per-site hosts for the agentless JSON span intake. Regional data centers serve it from
// browser-intake-* hosts rather than public-trace-http-intake.logs.<site>, so a single template
// silently drops spans on us3/us5/ap1/ap2. Mirrors dd-trace-py's AgentlessTraceWriter.INTAKE_URLS
// (DataDog/dd-trace-py#18514).
const INTAKE_URLS = {
  'datadoghq.com': 'https://public-trace-http-intake.logs.datadoghq.com',
  'datadoghq.eu': 'https://public-trace-http-intake.logs.datadoghq.eu',
  'us3.datadoghq.com': 'https://trace.browser-intake-us3-datadoghq.com',
  'us5.datadoghq.com': 'https://trace.browser-intake-us5-datadoghq.com',
  'ap1.datadoghq.com': 'https://browser-intake-ap1-datadoghq.com',
  'ap2.datadoghq.com': 'https://browser-intake-ap2-datadoghq.com',
  'uk1.datadoghq.com': 'https://browser-intake-uk1-datadoghq.com',
  'datad0g.com': 'https://public-trace-http-intake.logs.datad0g.com',
}

// Path of the JSON span intake on every intake host.
const INTAKE_PATH = '/api/v2/spans'
const STATS_INTAKE_PATH = '/api/v0.2/stats'

/**
 * Resolves the agentless intake origin for a Datadog site.
 *
 * Unknown sites fall back to the browser-intake naming: strip the TLD, dash-join the rest, then
 * reattach the TLD, e.g. 'us2.ddog-gov.com' -> 'https://browser-intake-us2-ddog-gov.com'.
 *
 * @param {string} [site] - The Datadog site, e.g. 'us3.datadoghq.com'. Defaults to 'datadoghq.com'.
 * @returns {string} The intake origin, without a path.
 */
function computeIntakeUrl (site = 'datadoghq.com') {
  const siteUrl = createSiteUrl(site)
  if (siteUrl === undefined) {
    throw new TypeError(`Invalid Datadog site: ${site}`)
  }

  const normalized = siteUrl.hostname
  const known = INTAKE_URLS[normalized]
  if (known !== undefined) {
    return known
  }

  const lastDot = normalized.lastIndexOf('.')
  const prefix = lastDot === -1 ? '' : normalized.slice(0, lastDot)
  const tld = lastDot === -1 ? normalized : normalized.slice(lastDot + 1)
  return `https://browser-intake-${prefix.replaceAll('.', '-')}.${tld}`
}

/**
 * @param {string} [site] - The Datadog site. Defaults to 'datadoghq.com'.
 * @returns {string} The client stats intake endpoint.
 */
function computeStatsIntakeUrl (site = 'datadoghq.com') {
  const url = createSiteUrl(site, 'trace.agent')
  if (url === undefined) {
    throw new TypeError(`Invalid Datadog site: ${site}`)
  }

  url.pathname = STATS_INTAKE_PATH
  return url.href
}

module.exports = { INTAKE_URLS, INTAKE_PATH, computeIntakeUrl, computeStatsIntakeUrl }
