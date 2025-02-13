'use strict'

module.exports = {
  ASM_ACTIVATION: 1n << 1n,
  ASM_IP_BLOCKING: 1n << 2n,
  ASM_DD_RULES: 1n << 3n,
  ASM_EXCLUSIONS: 1n << 4n,
  ASM_REQUEST_BLOCKING: 1n << 5n,
  ASM_RESPONSE_BLOCKING: 1n << 6n,
  ASM_USER_BLOCKING: 1n << 7n,
  ASM_CUSTOM_RULES: 1n << 8n,
  ASM_CUSTOM_BLOCKING_RESPONSE: 1n << 9n,
  ASM_TRUSTED_IPS: 1n << 10n,
  ASM_API_SECURITY_SAMPLE_RATE: 1n << 11n, // deprecated
  APM_TRACING_SAMPLE_RATE: 1n << 12n,
  APM_TRACING_LOGS_INJECTION: 1n << 13n,
  APM_TRACING_HTTP_HEADER_TAGS: 1n << 14n,
  APM_TRACING_CUSTOM_TAGS: 1n << 15n,
  ASM_PROCESSOR_OVERRIDES: 1n << 16n, // not yet used
  ASM_CUSTOM_DATA_SCANNERS: 1n << 17n, // not yet used
  ASM_EXCLUSION_DATA: 1n << 18n, // not yet used
  APM_TRACING_ENABLED: 1n << 19n,
  APM_TRACING_DATA_STREAMS_ENABLED: 1n << 20n, // not yet used
  ASM_RASP_SQLI: 1n << 21n,
  ASM_RASP_LFI: 1n << 22n,
  ASM_RASP_SSRF: 1n << 23n,
  ASM_RASP_SHI: 1n << 24n,
  ASM_RASP_XXE: 1n << 25n, // not yet used
  ASM_RASP_RCE: 1n << 26n, // not yet used
  ASM_RASP_NOSQLI: 1n << 27n, // not yet used
  ASM_RASP_XSS: 1n << 28n, // not yet used
  APM_TRACING_SAMPLE_RULES: 1n << 29n,
  CSM_ACTIVATION: 1n << 30n, // not yet used
  ASM_AUTO_USER_INSTRUM_MODE: 1n << 31n,
  ASM_ENDPOINT_FINGERPRINT: 1n << 32n,
  ASM_SESSION_FINGERPRINT: 1n << 33n, // not yet used
  ASM_NETWORK_FINGERPRINT: 1n << 34n,
  ASM_HEADER_FINGERPRINT: 1n << 35n,
  ASM_TRUNCATION_RULES: 1n << 36n, // not yet used
  ASM_RASP_CMDI: 1n << 37n,
  APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION: 1n << 38n, // not yet used
  APM_TRACING_ENABLE_EXCEPTION_REPLAY: 1n << 39n, // not yet used
  APM_TRACING_ENABLE_CODE_ORIGIN: 1n << 40n, // not yet used
  APM_TRACING_ENABLE_LIVE_DEBUGGING: 1n << 41n, // not yet used
}
