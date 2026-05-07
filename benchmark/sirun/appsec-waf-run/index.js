'use strict'

const assert = require('node:assert/strict')

const addresses = require('../../../packages/dd-trace/src/appsec/addresses')
const Reporter = require('../../../packages/dd-trace/src/appsec/reporter')

// Stub Reporter so the bench measures the WAF wrapper's per-call work, not the
// reporter's tag / metric handoff. Mutates the module exports in-process; the
// bench process never imports anything else that depends on Reporter.
Reporter.reportAttack = () => {}
Reporter.reportAttributes = () => {}
Reporter.reportMetrics = () => {}
Reporter.reportRaspRuleSkipped = () => {}

const WAFContextWrapper = require('../../../packages/dd-trace/src/appsec/waf/waf_context_wrapper')

const { VARIANT } = process.env

const ITERATIONS = 8_000_000

// Stub native WAF context — the real one shells out to `@datadog/native-appsec`,
// which dwarfs the wrapper's own work and isn't what we want to measure here.
let ddwafCalls = 0
const ddwafContext = {
  disposed: false,
  run () {
    ddwafCalls++
    return {
      events: undefined,
      actions: undefined,
      duration: 200,
      timeout: false,
      attributes: undefined,
      metrics: undefined,
      errorCode: 0,
    }
  },
  dispose () {},
}

const knownAddresses = new Set([
  addresses.HTTP_INCOMING_HEADERS,
  addresses.HTTP_INCOMING_QUERY,
  addresses.HTTP_INCOMING_BODY,
  addresses.HTTP_INCOMING_URL,
  addresses.HTTP_INCOMING_METHOD,
  addresses.HTTP_INCOMING_PARAMS,
  addresses.HTTP_INCOMING_COOKIES,
  addresses.HTTP_CLIENT_IP,
])

// Realistic per-request inputs: 8 known headers, a query string with two
// parameters, the URL, the method, and a small JSON body.
const PERSISTENT = {
  [addresses.HTTP_INCOMING_HEADERS]: {
    host: 'example.com',
    'user-agent': 'curl/8.0',
    accept: '*/*',
    'content-type': 'application/json',
    'x-forwarded-for': '10.0.0.1',
    'x-request-id': 'req-12345',
    authorization: 'Bearer xxx',
    'accept-encoding': 'gzip',
  },
  [addresses.HTTP_INCOMING_QUERY]: { q: 'test', limit: '10' },
  [addresses.HTTP_INCOMING_BODY]: { items: [1, 2, 3] },
  [addresses.HTTP_INCOMING_URL]: '/api/items',
  [addresses.HTTP_INCOMING_METHOD]: 'GET',
}

const EPHEMERAL = {
  [addresses.HTTP_INCOMING_PARAMS]: { id: 'abc' },
  [addresses.HTTP_CLIENT_IP]: '10.0.0.1',
}

const wrapper = new WAFContextWrapper(ddwafContext, 5000, '1.0.0', '1.2.3', knownAddresses)

// Pre-flight: confirm the wrapper actually reached the native run path with the
// expected payload shape. Reset the counter afterwards so the loop measurement
// starts fresh.
wrapper.run({ persistent: PERSISTENT, ephemeral: EPHEMERAL })
assert.equal(ddwafCalls, 1, 'WAFContextWrapper.run did not hit the native ddwafContext path')
ddwafCalls = 0

if (VARIANT === 'persistent-only') {
  // Common shape: only persistent inputs (initial dispatch, no per-route extras).
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    wrapper.run({ persistent: PERSISTENT, ephemeral: undefined })
  }
} else if (VARIANT === 'persistent-and-ephemeral') {
  // Full shape: persistent + ephemeral (route params dispatched after the body).
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    wrapper.run({ persistent: PERSISTENT, ephemeral: EPHEMERAL })
  }
}
