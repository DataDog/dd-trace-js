'use strict'

const DEPENDENT_FLAG_VARIANT_KEY_V1 = 'dependent-flag-variant-key-v1'

// The bundled evaluator and tracer hooks must support prerequisite evaluation,
// error propagation, and exposure reporting before this report can opt in.
function getEvaluatorCapabilities () {
  return []
}

module.exports = { DEPENDENT_FLAG_VARIANT_KEY_V1, getEvaluatorCapabilities }
