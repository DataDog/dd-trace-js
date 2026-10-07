'use strict'

const assert = require('assert')

let flakyAttempts = 0

describe('quarantine snapshot', () => {
  it('fails a snapshot', () => {
    expect('received').toMatchSnapshot()
  })

  it('fails before a snapshot', () => {
    assert.strictEqual(1 + 2, 4)
    expect('stored').toMatchSnapshot()
  })

  it('fails a snapshot before passing', () => {
    expect(++flakyAttempts > 1 ? 'stored' : 'received').toMatchSnapshot()
  })

  it('can pass normally', () => {
    expect('stored').toMatchSnapshot()
  })
})
