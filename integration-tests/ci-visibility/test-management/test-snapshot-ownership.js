'use strict'

const { describe, it, expect } = globalThis.expect ? globalThis : require('@jest/globals')

describe('snapshot ownership', () => {
  it('ordinary: quarantined', () => {
    expect(true).toBe(true)
  })

  it('ordinary', () => {
    expect('stored').toMatchSnapshot()
    if (!process.env.SKIP_ORDINARY_HINT) {
      expect('stored').toMatchSnapshot('quarantined')
      expect('stored').toMatchSnapshot('quarantined')
      expect('stored').toMatchSnapshot('quarantined: response')
    }
  })
})
