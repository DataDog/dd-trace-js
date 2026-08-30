'use strict'

// Serialized into browsers by browser-test integrations. Excluded from coverage by filename.

/**
 * @param {string|undefined} correlationCookieName
 * @returns {{ isRumInstrumented: boolean, isRumActive: boolean, rumSamplingRate: number | null }}
 */
function detectRum (correlationCookieName) {
  const isRumInstrumented = !!window.DD_RUM
  const isRumActive = window.DD_RUM && window.DD_RUM.getInternalContext
    ? !!window.DD_RUM.getInternalContext()
    : false
  const rumSamplingRate = window.DD_RUM && window.DD_RUM.getInitConfiguration
    ? window.DD_RUM.getInitConfiguration().sessionSampleRate
    : null

  if (isRumActive && correlationCookieName) {
    window.addEventListener('pagehide', () => {
      // WebDriver cannot issue a cookie command after this browsing context unloads.
      // eslint-disable-next-line unicorn/no-document-cookie
      document.cookie = `${correlationCookieName}=; Max-Age=0; path=/`
    }, { once: true })
  }

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
