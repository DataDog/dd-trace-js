'use strict'

const Scope = require('../../src/scope/sync')
const testScope = require('./test')

describe('Scope (sync)', () => {
  let scope

  beforeEach(() => {
    scope = new Scope()
  })

  testScope(() => scope, false)
})
