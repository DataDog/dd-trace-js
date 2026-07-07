'use strict'

const {
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_PAYLOAD_SIZE_LIMIT,
} = require('../../evp_proxy/constants')

module.exports = {
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_SUBDOMAIN_HEADER_NAME,

  SPANS_EVENT_TYPE: 'span',
  SPANS_INTAKE: 'llmobs-intake',
  SPANS_ENDPOINT: '/api/v2/llmobs',

  EVALUATIONS_INTAKE: 'api',
  EVALUATIONS_EVENT_TYPE: 'evaluation_metric',
  EVALUATIONS_ENDPOINT: '/api/intake/llm-obs/v2/eval-metric',

  EVP_PAYLOAD_SIZE_LIMIT, // 5MB (actual limit is 5.1MB)
  EVP_EVENT_SIZE_LIMIT: 5 << 20, // 5MB (actual backend limit is 10MB; Python SDK defaults to 5MB)
}
