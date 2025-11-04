'use strict'

function createExposureEvent(context, details) {
  // Only log if doLog flag is true
  if (!details.flagMetadata?.doLog) {
    return
  }

  // Skip logging if allocation key or variant is missing (this should never happen)
  const allocationKey = details.flagMetadata?.allocationKey
  const variantKey = details.variant
  if (!allocationKey || !variantKey) {
    return
  }

  const { targetingKey: id = '', ...attributes } = context

  return {
    allocation: {
      key: allocationKey,
    },
    flag: {
      key: details.flagKey,
    },
    variant: {
      key: variantKey,
    },
    subject: {
      id,
      attributes,
    },
  }
}

module.exports = {
  createExposureEvent
}