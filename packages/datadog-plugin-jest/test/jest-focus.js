'use strict'

describe('jest-test-focused', () => {
  it('will be skipped', () => {
    expect(true).toEqual(true)
  })
  // eslint-disable-next-line
  it.only('can do focused test', () => {
    expect(true).toEqual(true)
  })
})

describe('jest-test-focused-2', () => {
  it('will be skipped too', () => {
    expect(true).toEqual(true)
  })
})
