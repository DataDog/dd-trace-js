'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const satisfies = require('../../../../vendor/dist/semifies')
const instrumentations = require('../../src/helpers/instrumentations')
const { getParse, getMatch } = require('../../src/path-to-regexp')

// Run the hooks the loader would run for `version`, exactly as register.js selects them.
function applyHooksFor (version, moduleExports) {
  for (const { versions, hook } of instrumentations['path-to-regexp']) {
    if (!versions || versions.some(range => satisfies(version, range))) hook(moduleExports)
  }
}

// 7.x `parse()` also returns `{ tokens }`, but its tokens are bare strings rather than typed nodes,
// so adopting it would make every route normalize to '/'. Only 8.x may install the adapters.
const v7Module = {
  parse: () => ({ tokens: ['/a/', { name: 'id' }], delimiter: '/' }),
  match: () => () => ({ params: {} }),
  pathToRegexp: () => ({ regexp: /^\/a\/([^/]+)$/, keys: [] }),
}

const v8Module = {
  parse: pattern => ({ tokens: [{ type: 'text', value: pattern }] }),
  match: () => () => ({ params: { id: '1' } }),
  pathToRegexp: () => ({ regexp: /^\/a\/([^/]+)$/, keys: [] }),
}

describe('path-to-regexp instrumentation', () => {
  it('does not let 7.x install the parse/match adapters', () => {
    const parseBefore = getParse()
    const matchBefore = getMatch()

    applyHooksFor('7.2.0', v7Module)

    assert.equal(getParse(), parseBefore)
    assert.equal(getMatch(), matchBefore)
  })

  it('installs the adapters for 8.x', () => {
    applyHooksFor('8.4.2', v8Module)

    assert.equal(typeof getParse(), 'function')
    assert.equal(typeof getMatch(), 'function')
    const parse = getParse()
    assert.deepStrictEqual(parse('/x'), { tokens: [{ type: 'text', value: '/x' }] })
    const match = getMatch()
    const matchPath = match('/a/:id')
    assert.deepStrictEqual(matchPath('/a/1'), { id: '1' })
  })
})
