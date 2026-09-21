'use strict'

module.exports = {
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

  FLAG_EVALUATION_ENDPOINT: '/api/v2/flagevaluation',
  FLAG_EVALUATION_FLUSH_INTERVAL: 10_000,
  FLAG_EVALUATION_QUEUE_CAP: 4096,
  FLAG_EVALUATION_GLOBAL_CAP: 131_072,
  FLAG_EVALUATION_PER_FLAG_CAP: 10_000,
  FLAG_EVALUATION_DEGRADED_CAP: 32_768,

  /**
   * @constant
   * @type {string} Channel name for exposure event submission
   */
  EXPOSURE_CHANNEL: 'ffe:exposure:submit',

  /**
   * @constant
   * @type {string} Reason code for noop provider evaluations
   */
  NOOP_REASON: 'STATIC',
}
