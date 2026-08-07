'use strict'

const normalizePayload = require('./normalize-waf-sample')

const nativeAppsecPath = require.resolve('@datadog/native-appsec')
const nativeAppsec = require(nativeAppsecPath)
const { DDWAF } = nativeAppsec

let recorded = false

class RecordingDDWAF extends DDWAF {
  /**
   * @returns {object}
   */
  createContext () {
    const context = super.createContext()
    const calls = []
    const knownAddresses = [...this.knownAddresses].sort()

    return {
      disposed: false,

      /**
       * @param {object} payload
       * @param {number} timeout
       * @returns {object}
       */
      run (payload, timeout) {
        const result = context.run(payload, timeout)
        calls.push({ payload: normalizePayload(payload), result: { ...result, duration: 0 } })
        return result
      },

      /**
       * @returns {void}
       */
      dispose () {
        if (!recorded) {
          recorded = true
          process.stdout.write(`${JSON.stringify({ knownAddresses, sample: calls })}\n`)
        }
        context.dispose()
        this.disposed = true
      },
    }
  }
}

require.cache[nativeAppsecPath].exports = { ...nativeAppsec, DDWAF: RecordingDDWAF }
