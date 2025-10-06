'use strict'

module.exports = {
  EVP_PROXY_AGENT_BASE_PATH: '/evp_proxy/v2/',
  EVP_SUBDOMAIN_HEADER_NAME: 'X-Datadog-EVP-Subdomain',
  EVP_SUBDOMAIN_VALUE: 'event-platform-intake',
  EXPOSURES_ENDPOINT: '/api/v2/exposures',

  // EVP intake limits
  EVP_PAYLOAD_SIZE_LIMIT: 5 << 20, // 5MB (actual limit is 5.1MB)
  EVP_EVENT_SIZE_LIMIT: (1 << 20) - 1024, // 999KB (actual limit is 1MB)

  EXPOSURE_CHANNEL: 'ffe:exposure:submit',
  NOOP_REASON: 'STATIC'
}
