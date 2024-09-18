'use strict'

module.exports = {
  EVP_PROXY_AGENT_BASE_PATH: 'evp_proxy/v2',
  EVP_PROXY_AGENT_ENDPOINT: 'evp_proxy/v2/api/v2/llmobs',
  EVP_SUBDOMAIN_HEADER_NAME: 'X-Datadog-EVP-Subdomain',
  EVP_SUBDOMAIN_HEADER_VALUE: 'llmobs-intake',

  EVP_PAYLOAD_SIZE_LIMIT: 5 << 20, // 5MB (actual limit is 5.1MB)
  EVP_EVENT_SIZE_LIMIT: (1 << 20) - 1024, // 999KB (actual limit is 1MB)

  DROPPED_IO_COLLECTION_ERROR: 'dropped_io',
  DROPPED_VALUE_TEXT: "[This value has been dropped because this span's size exceeds the 1MB size limit.]"
}
