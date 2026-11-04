'use strict'

/**
 * Snapshot scalar split features in canonical key order for stable aggregation.
 * A prefix selects one provider destination; hook-only metadata must not reach intake.
 * @param {unknown} source
 * @param {string} [prefix]
 * @returns {Record<string, string | number | boolean> | undefined}
 */
function snapshotFeatures (source, prefix = '') {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return
  let features
  for (const key of Object.keys(source).sort()) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    const value = descriptor?.value
    if (typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) continue
    features ??= Object.create(null)
    features[key.slice(prefix.length)] = value
  }
  return features
}

module.exports = { snapshotFeatures }
