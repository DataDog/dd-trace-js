'use strict'

const assert = require('node:assert/strict')

const { getConfigFresh } = require('../helpers/config')

describe('getConfigFresh test helper', () => {
  // `getConfigFresh` reloads the config graph through `proxyquire` on every call so
  // each spec gets pristine module state. proxyquire links every freshly loaded module
  // into the helper module's `children`, which pinned each re-instrumented copy for the
  // whole process and grew the appsec suite's heap until it OOMed under coverage.
  it('does not pin freshly loaded config modules across calls', () => {
    const helperModule = require.cache[require.resolve('../helpers/config')]

    getConfigFresh({})
    const childCount = helperModule.children.length

    getConfigFresh({})
    getConfigFresh({})

    assert.strictEqual(helperModule.children.length, childCount)
  })
})
