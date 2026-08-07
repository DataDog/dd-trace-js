'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// eslint-disable-next-line import/order -- the startup guard must load before the native addon
const { DDWAF } = require('@datadog/native-appsec')

const samples = require('../appsec/waf-samples.json')
const rules = require('../../../packages/dd-trace/src/appsec/recommended.json')

const operations = Number(process.env.OPERATIONS)
const sample = samples[process.env.WAF_SAMPLE]

assert.ok(operations > 0, 'OPERATIONS must be positive')
assert.ok(sample, `unknown WAF_SAMPLE: ${process.env.WAF_SAMPLE}`)

// Keep these aligned with the production defaults without loading the configuration manifest into the benchmark.
const obfuscatorKeyRegex = '(?i)pass|pw(?:or)?d|secret|(?:api|private|public|access)[_-]?key|token|' +
  'consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization|' +
  'jsessionid|phpsessid|asp\\.net[_-]sessionid|sid|jwt'
const obfuscatorValueRegex =
  '(?i)(?:p(?:ass)?w(?:or)?d|pass(?:[_-]?phrase)?|secret(?:[_-]?key)?|' +
  '(?:(?:api|private|public|access)[_-]?)key(?:[_-]?id)?|' +
  '(?:(?:auth|access|id|refresh)[_-]?)?token|consumer[_-]?(?:id|key|secret)|' +
  'sign(?:ed|ature)?|auth(?:entication|orization)?|jsessionid|phpsessid|' +
  'asp\\.net(?:[_-]|-)sessionid|sid|jwt)(?:\\s*=([^;&]+)|"\\s*:\\s*("[^"]+"|\\d+))|' +
  'bearer\\s+([a-z0-9\\._\\-]+)|token\\s*:\\s*([a-z0-9]{13})|gh[opsu]_([0-9a-zA-Z]{36})|' +
  'ey[I-L][\\w=-]+\\.(ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?)|' +
  '[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}([^\\-]+)[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|' +
  'ssh-rsa\\s*([a-z0-9\\/\\.+]{100,})'

const waf = new DDWAF(rules, 'benchmark/sirun/appsec-waf', {
  obfuscatorKeyRegex,
  obfuscatorValueRegex,
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
