'use strict'

const MAX_SERVICE_LENGTH = 100

/**
 * Normalize an inferred service name so APM and runtime metrics agree.
 *
 * The trace agent normalizes span service names on the wire, but the
 * DogStatsD client uses a different tag-value sanitizer, so an inferred
 * `@scope/name` package name appears as `scope/name` in APM and
 * `_scope/name` in runtime metrics. Pre-normalizing pins both consumers
 * (and telemetry / process tags) to the same value.
 *
 * @see https://github.com/DataDog/datadog-agent/blob/main/pkg/trace/traceutil/normalize.go
 * @param {string | undefined} name
 */
function normalizeService (name) {
  if (!name) return

  let normalized = name.toLowerCase()
    .replaceAll(/[^a-z0-9_:./-]/g, '_')
    .replace(/^[^a-z0-9]+/, '')

  if (normalized.length > MAX_SERVICE_LENGTH) {
    normalized = normalized.slice(0, MAX_SERVICE_LENGTH)
  }

  return normalized
}

module.exports = { normalizeService }
