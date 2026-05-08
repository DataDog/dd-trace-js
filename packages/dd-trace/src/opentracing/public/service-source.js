'use strict'

const { SVC_SRC_KEY } = require('../../constants')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'
const MANUAL = 'm'

/**
 * @param {Record<string, unknown> | null | undefined} tags
 * @returns {boolean}
 */
function tagsHaveManualService (tags) {
  return tags != null && Boolean(tags[SERVICE_KEY] || tags[SERVICE_NAME_KEY])
}

/**
 * Returns a copy of `options` with the manual service-source marker tag added
 * when the caller supplied a user-controlled service name. Returns the input
 * unchanged when there's nothing to mark.
 *
 * @template {{ service?: unknown, tags?: Record<string, unknown> } | null | undefined} T
 * @param {T} options
 * @returns {T}
 */
function markManualService (options) {
  if (options == null) return options
  if (!options.service && !tagsHaveManualService(options.tags)) return options
  return { ...options, tags: { ...options.tags, [SVC_SRC_KEY]: MANUAL } }
}

module.exports = {
  SERVICE_KEY,
  SERVICE_NAME_KEY,
  MANUAL,
  tagsHaveManualService,
  markManualService,
}
