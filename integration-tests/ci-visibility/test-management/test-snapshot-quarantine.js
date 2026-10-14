'use strict'

const assert = require('assert')

const { describe, it, expect } = globalThis.expect ? globalThis : require('@jest/globals')

let flakyAttempts = 0

describe('quarantine snapshot', () => {
  if (process.env.MIXED_SNAPSHOT_SUITE) {
    it.concurrent('concurrent passing sibling', () => {
      expect(true).toBe(true)
    })
  }

  it('fails a snapshot', () => {
    expect('received').toMatchSnapshot()
  })

  it('fails before a snapshot', () => {
    assert.strictEqual(1 + 2, 4)
    expect('stored').toMatchSnapshot('response')
  })

  it('fails a snapshot before passing', () => {
    expect(++flakyAttempts > 1 ? 'stored' : 'received').toMatchSnapshot()
  })

  it('can pass normally', () => {
    expect('stored').toMatchSnapshot()
  })

  it('passes with an unused snapshot', () => {
    expect('stored').toMatchSnapshot()
  })
})
