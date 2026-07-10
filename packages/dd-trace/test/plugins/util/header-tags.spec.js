'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('plugins/util/header-tags', () => {
  let toHeaderTagEntries
  let log

  beforeEach(() => {
    log = { warn: sinon.spy() }
    // Fresh module per test so the once-only deprecation flag resets.
    ;({ toHeaderTagEntries } = proxyquire('../../../src/plugins/util/header-tags', {
      '../../log': log,
    }))
  })

  it('returns an empty array for nullish input', () => {
    assert.deepStrictEqual(toHeaderTagEntries(undefined), [])
    assert.deepStrictEqual(toHeaderTagEntries(null), [])
  })

  it('maps an object to lowercased [header, tag] pairs', () => {
    assert.deepStrictEqual(
      toHeaderTagEntries({ 'X-User-Id': 'user.id', 'X-Team': '' }),
      [['x-user-id', 'user.id'], ['x-team', undefined]]
    )
    sinon.assert.notCalled(log.warn)
  })

  it('accepts the legacy array form and lowercases keys, trimming whitespace', () => {
    assert.deepStrictEqual(
      toHeaderTagEntries(['X-User-Id : user.id', 'X-Team']),
      [['x-user-id', 'user.id'], ['x-team', undefined]]
    )
  })

  it('accepts HTTP/2 pseudo-headers in the legacy array form', () => {
    assert.deepStrictEqual(
      toHeaderTagEntries([':path', ':method:http.request.method']),
      [[':path', undefined], [':method', 'http.request.method']]
    )
  })

  it('skips non-string entries in the legacy array form', () => {
    assert.deepStrictEqual(
      toHeaderTagEntries(['x-a:tag', 123, undefined, 'x-b']),
      [['x-a', 'tag'], ['x-b', undefined]]
    )
  })

  it('warns exactly once for the legacy array form', () => {
    toHeaderTagEntries(['x-a:tag'])
    toHeaderTagEntries(['x-b:tag'])
    sinon.assert.calledOnce(log.warn)
  })

  it('does not warn for the object form', () => {
    toHeaderTagEntries({ 'x-a': 'tag' })
    sinon.assert.notCalled(log.warn)
  })
})
