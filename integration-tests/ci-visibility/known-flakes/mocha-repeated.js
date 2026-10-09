'use strict'

describe('repeated runs', () => {
  it('listed failure', () => { throw new Error('listed failure') })
  it('unlisted failure', () => { throw new Error('unlisted failure') })
})
