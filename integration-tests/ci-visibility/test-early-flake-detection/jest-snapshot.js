'use strict'

describe('test', () => {
  it('can do snapshot', () => {
    expect(1 + 2).toMatchSnapshot()
  })
})
