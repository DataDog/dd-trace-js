'use strict'

const sum = require('../test/sum')

it('included first-file test', () => {
  sum(1, 2)
})

it('excluded first-file test', () => {})
