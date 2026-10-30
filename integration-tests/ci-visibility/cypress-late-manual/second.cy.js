'use strict'

describe('second suite', () => {
  it('fails in a late hook', () => {})
  after(() => { throw new Error('synthetic late hook failure') })
})
