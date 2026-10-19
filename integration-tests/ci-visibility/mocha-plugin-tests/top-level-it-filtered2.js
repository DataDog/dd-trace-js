'use strict'

const sum = require('../test/sum')

it('included second-file test', () => {
  sum(3, 4)
})

it('excluded second-file test', () => {})
