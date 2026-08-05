'use strict'

const assert = require('node:assert/strict')

const normalizePayload = require('./normalize-waf-sample')
const samples = require('./waf-samples.json')

const nativeAppsecPath = require.resolve('@datadog/native-appsec')

const sample = samples[process.env.WAF_SAMPLE]
assert.ok(sample, `unknown WAF_SAMPLE: ${process.env.WAF_SAMPLE}`)

const expectedPayloads = []
for (const { payload } of sample) {
  expectedPayloads.push(payload)
}

let validateNextContext = true
let replayValidated = false

class ReplayingDDWAF {
  /**
   * @returns {string}
   */
  static version () {
    return 'replay'
  }

  /**
   * Create the metadata used by the production WAF wrapper.
   */
  constructor () {
    this.configPaths = ['datadog/00/ASM_DD/default/config']
    this.diagnostics = { rules: {}, ruleset_version: 'replay' }
    this.knownAddresses = new Set(samples.knownAddresses)
  }

  /**
   * @returns {object}
   */
  createContext () {
    const validate = validateNextContext
    validateNextContext = false

    const payloads = []
    let callIndex = 0

    return {
      disposed: false,

      /**
       * @param {object} payload
       * @returns {object}
       */
      run (payload) {
        if (validate) {
          payloads.push(normalizePayload(payload))
        }
        return sample[callIndex++].result
      },

      /**
       * @returns {void}
       */
      dispose () {
        if (validate) {
          assert.strictEqual(callIndex, sample.length)
          assert.deepStrictEqual(payloads, expectedPayloads)
          replayValidated = true
        }
        this.disposed = true
      },
    }
  }

  /**
   * @returns {void}
   */
  dispose () {}
}

function assertReplayValidated () {
  assert.ok(replayValidated, 'AppSec did not run the replayed WAF context during warmup')
}

require.cache[nativeAppsecPath] = {
  children: [],
  exports: { DDWAF: ReplayingDDWAF },
  filename: nativeAppsecPath,
  id: nativeAppsecPath,
  loaded: true,
  paths: [],
}

module.exports = assertReplayValidated
