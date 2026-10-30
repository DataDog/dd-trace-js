'use strict'

before(() => {
  throw new Error('intentional root hook failure')
})

it('does not run after the root hook fails', () => {})
