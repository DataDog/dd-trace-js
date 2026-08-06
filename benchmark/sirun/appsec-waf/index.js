'use strict'

const assert = require('node:assert/strict')

const { DDWAF } = require('@datadog/native-appsec')

const guard = require('../startup-guard')
const samples = require('../appsec/waf-samples.json')
const rules = require('../../../packages/dd-trace/src/appsec/recommended.json')

const operations = Number(process.env.OPERATIONS)
const sample = samples[process.env.WAF_SAMPLE]

assert.ok(operations > 0, 'OPERATIONS must be positive')
assert.ok(sample, `unknown WAF_SAMPLE: ${process.env.WAF_SAMPLE}`)

const waf = new DDWAF(rules, 'benchmark/sirun/appsec-waf', {
  obfuscatorKeyRegex: '',
  obfuscatorValueRegex: '',
})

/**
 * @param {boolean} verify
 * @returns {void}
 */
function runRequest (verify) {
  const context = waf.createContext()
  let matched = false

  for (const { payload } of sample) {
    const result = context.run(payload, 5e3)
    if (verify && result.events?.length) {
      matched = true
    }
  }

  context.dispose()

  if (verify) {
    assert.strictEqual(matched, process.env.WAF_SAMPLE === 'attack')
  }
}

for (let i = 0; i < 100; i++) {
  runRequest(i === 0)
}

guard.loopStart()
for (let i = 0; i < operations; i++) {
  runRequest(false)
}
guard.done(0.1)

waf.dispose()
