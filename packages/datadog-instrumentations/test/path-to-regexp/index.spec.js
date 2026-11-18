'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
// eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require
const realPathToRegexp = require('path-to-regexp')

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

describe('path-to-regexp instrumentation', () => {
  it('does not let 7.x install the parse/match adapters', () => {
    const parseBefore = getParse()
    const matchBefore = getMatch()

    applyHooksFor('7.2.0', v7Module)

    assert.equal(getParse(), parseBefore)
    assert.equal(getMatch(), matchBefore)
  })

  it('does not install the adapters when 8.x lacks TokenData', () => {
    const parseBefore = getParse()
    const matchBefore = getMatch()

    applyHooksFor('8.4.2', { ...realPathToRegexp, TokenData: undefined })

    assert.equal(getParse(), parseBefore)
    assert.equal(getMatch(), matchBefore)
  })

  it('installs the adapters for 8.x', () => {
    applyHooksFor('8.4.2', realPathToRegexp)

    assert.equal(typeof getParse(), 'function')
    assert.equal(typeof getMatch(), 'function')
    const parse = getParse()
    const { tokens } = parse('/a/:id')
    assert.deepStrictEqual(tokens, [{ type: 'text', value: '/a/' }, { type: 'param', name: 'id' }])
    const makeMatcher = getMatch()
    const matchPath = makeMatcher(tokens)
    // Values stay raw (no decode), so a malformed escape still matches.
    assert.deepStrictEqual({ ...matchPath('/a/%ZZ') }, { id: '%ZZ' })
    assert.equal(matchPath('/b/1'), undefined)
    assert.equal(parse('/a/:'), undefined)
  })
})
