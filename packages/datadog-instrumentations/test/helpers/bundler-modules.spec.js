'use strict'

const assert = require('node:assert/strict')

describe('bundler modules', () => {
  it('includes package roots, internals, and both builtin specifiers', () => {
    const modules = require('../../src/helpers/bundler-modules')

    assert.strictEqual(modules.has('fastify'), true)
    assert.strictEqual(modules.has('@anthropic-ai/sdk/resources/messages.js'), true)
    assert.strictEqual(modules.has('http'), true)
    assert.strictEqual(modules.has('node:http'), true)
  })
})
