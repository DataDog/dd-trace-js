'use strict'

const { expect } = require('chai')

describe('parameterized', () => {
  test.each(['parameter 1', 'parameter 2'])('test %s', (value) => {
    expect(value.startsWith('parameter')).toEqual(true)
  })
})
