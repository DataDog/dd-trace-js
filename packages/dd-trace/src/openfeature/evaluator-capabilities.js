'use strict'

const DEPENDENT_FLAG_VARIANT_KEY_V1 = 'dependent-flag-variant-key-v1'

function getEvaluatorCapabilities () {
  return [DEPENDENT_FLAG_VARIANT_KEY_V1]
}

module.exports = { DEPENDENT_FLAG_VARIANT_KEY_V1, getEvaluatorCapabilities }
