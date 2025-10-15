'use strict'

module.exports = {
  /**
   * @constant
   * @type {string} Base path for EVP proxy agent endpoint
   */
  EVP_PROXY_AGENT_BASE_PATH: '/evp_proxy/v2/',

  /**
   * @constant
   * @type {string} HTTP header name for EVP subdomain routing
   */
  EVP_SUBDOMAIN_HEADER_NAME: 'X-Datadog-EVP-Subdomain',

  /**
   * @constant
   * @type {string} EVP subdomain value for event platform intake
   */
  EVP_SUBDOMAIN_VALUE: 'event-platform-intake',

  /**
   * @constant
   * @type {string} API endpoint for exposure events EVP track
   */
  EXPOSURES_ENDPOINT: '/api/v2/exposures',

  /**
   * @constant
   * @type {number} Maximum payload size for EVP intake (5MB, actual limit is 5.1MB)
   */
  EVP_PAYLOAD_SIZE_LIMIT: 5 << 20,

  /**
   * @constant
   * @type {number} Maximum individual event size (999KB, actual limit is 1MB)
   */
  EVP_EVENT_SIZE_LIMIT: (1 << 20) - 1024,

  /**
   * @constant
   * @type {string} Channel name for exposure event submission
   */
  EXPOSURE_CHANNEL: 'ffe:exposure:submit',

  /**
   * @constant
   * @type {string} Reason code for noop provider evaluations
   */
  NOOP_REASON: 'STATIC'
}
