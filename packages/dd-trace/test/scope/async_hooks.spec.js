'use strict'

const Scope = require('../../src/scope/async_hooks')
const testScope = require('./test')

wrapIt('async_hooks')

describe('Scope (async_hooks)', () => {
  let scope

  beforeEach(() => {
    scope = new Scope({
      experimental: {}
    })
  })

  testScope(() => scope)
})
