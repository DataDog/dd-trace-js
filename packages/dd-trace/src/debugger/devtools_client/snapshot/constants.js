'use strict'

const { getEnvironmentVariable } = require('../../../config-helper')

const largeObjectSkipThreshold = Number(
  getEnvironmentVariable('_DD_DYNAMIC_INSTRUMENTATION_EXPERIMENTAL_LARGE_OBJECT_SKIP_THRESHOLD')
)

module.exports = {
  /**
   * When collecting a snapshot, this constant controls what happens when objects with a large number of properties or
   * collections (arrays, maps, sets, etc.) with a large number of elements are detected:
   *
   * - If a collection is detected with more than this number of elements, none of its elements will be included in the
   *   snapshot.
   * - If an object is detected with more than this number of properties, it will be included in the snapshot, but
   *   snapshotting will be turned off for that probe in the future, until the probe is either updated or the Node.js
   *   process is restarted.
   */
  LARGE_OBJECT_SKIP_THRESHOLD: Number.isNaN(largeObjectSkipThreshold) ? 500 : largeObjectSkipThreshold,
  DEFAULT_MAX_COLLECTION_SIZE: 100,
  DEFAULT_MAX_FIELD_COUNT: 20,
  DEFAULT_MAX_LENGTH: 255,
  DEFAULT_MAX_REFERENCE_DEPTH: 3,
}
