'use strict'

// Serialized into browsers by browser-test integrations. Excluded from coverage by filename.

/** @returns {{ isRumInstrumented: boolean, isRumActive: boolean, rumSamplingRate: number | null }} */
function detectRum () {
  const isRumInstrumented = !!window.DD_RUM
  const isRumActive = window.DD_RUM && window.DD_RUM.getInternalContext
    ? !!window.DD_RUM.getInternalContext()
    : false
  const rumInitConfiguration = window.DD_RUM && window.DD_RUM.getInitConfiguration
    ? window.DD_RUM.getInitConfiguration()
    : undefined
  const rumSamplingRate = rumInitConfiguration ? rumInitConfiguration.sessionSampleRate : null

  return { isRumInstrumented, isRumActive, rumSamplingRate }
}

/** @returns {boolean} */
function stopRumSession () {
  if (window.DD_RUM && window.DD_RUM.stopSession) {
    window.DD_RUM.stopSession()
    return true
  }
  return false
}

module.exports = { detectRum, stopRumSession }
