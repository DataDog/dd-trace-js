'use strict'

// Serialized into chromium via Playwright's `page.evaluate`. Excluded from NYC by filename in
// `nyc.config.js` — rename only if you update that glob too.

/** @returns {{ isRumInstrumented: boolean, isRumActive: boolean, rumSamplingRate: number | null }} */
function detectRum () {
  const isRumInstrumented = !!window.DD_RUM
  const isRumActive = window.DD_RUM && window.DD_RUM.getInternalContext
    ? !!window.DD_RUM.getInternalContext()
    : false
  const rumSamplingRate = window.DD_RUM && window.DD_RUM.getInitConfiguration
    ? window.DD_RUM.getInitConfiguration().sessionSampleRate
    : null
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
