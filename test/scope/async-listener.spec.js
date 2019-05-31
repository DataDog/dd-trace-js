'use strict'

const Scope = require('../../src/scope/async-listener')
const testScope = require('./test')

wrapIt()

describe('Scope', () => {
  testScope(() => new Scope())
})
