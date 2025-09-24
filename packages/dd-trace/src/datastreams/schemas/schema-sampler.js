'use strict'

const SAMPLE_INTERVAL_MILLIS = 30 * 1000

class SchemaSampler {
  weight = 0
  lastSampleMs = 0

  trySample (currentTimeMs) {
    if (currentTimeMs >= this.lastSampleMs + SAMPLE_INTERVAL_MILLIS) {
      this.lastSampleMs = currentTimeMs
      const weight = this.weight
      this.weight = 0
      return weight
    }
    return 0
  }

  canSample (currentTimeMs) {
    this.weight += 1
    return currentTimeMs >= this.lastSampleMs + SAMPLE_INTERVAL_MILLIS
  }
}

module.exports = {
  SchemaSampler
}
