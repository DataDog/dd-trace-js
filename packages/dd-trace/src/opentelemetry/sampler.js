'use strict'

// This isn't used yet. We currently delegate to dd-trace core for sampling decisions.
// Leaving here for future use.
class Sampler {
  shouldSample (context, traceId, spanName, spanKind, attributes, links) {
    // 0 = no, 1 = record, 2 = record and sample
    // TODO: Make this actually do sampling...
    return { decision: 2 }
  }

  /** Returns the sampler name or short description with the configuration. */
  toString () {
    return 'DatadogSampler'
  }
}

module.exports = Sampler
