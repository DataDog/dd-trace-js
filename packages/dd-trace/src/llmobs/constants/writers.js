'use strict'

module.exports = {
  EVP_PROXY_AGENT_BASE_PATH: '/evp_proxy/v2/',
  EVP_SUBDOMAIN_HEADER_NAME: 'X-Datadog-EVP-Subdomain',

  SPANS_EVENT_TYPE: 'span',
  SPANS_INTAKE: 'llmobs-intake',
  SPANS_ENDPOINT: '/api/v2/llmobs',

  EVALUATIONS_INTAKE: 'api',
  EVALUATIONS_EVENT_TYPE: 'evaluation_metric',
  EVALUATIONS_ENDPOINT: '/api/intake/llm-obs/v1/eval-metric',

  EVP_PAYLOAD_SIZE_LIMIT: 5 << 20, // 5MB (actual limit is 5.1MB)
  EVP_EVENT_SIZE_LIMIT: (1 << 20) - 1024 // 999KB (actual limit is 1MB)
}
