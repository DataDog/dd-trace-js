'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const Module = require('node:module')

const { HOOK_ORDER, HOOK_STYLE } = process.env
const TARGET = /[\\/]graphql[\\/]execution[\\/]execute\.js$/

/**
 * Registers a `.js` handler the way other require hooks do: either wrapping `module._compile` before
 * delegating (pirates, ts-node) or compiling transformed source explicitly (istanbul-style coverage).
 */
function registerHook () {
  const load = Module._extensions['.js']

  Module._extensions['.js'] = function (module, filename) {
    if (!TARGET.test(filename)) return load.call(this, module, filename)

    if (HOOK_STYLE === 'prototype') {
      return Module.prototype._compile.call(module, transform(readFileSync(filename, 'utf8')), filename)
    }

    const compile = module._compile
    module._compile = function (content, filename) {
      return compile.call(this, transform(content), filename)
    }
    return load.call(this, module, filename)
  }
}

/**
 * @param {string} content
 */
function transform (content) {
  return `${content}\nglobalThis.hookTransformed = true\n`
}

if (HOOK_ORDER === 'before') registerHook()

// eslint-disable-next-line import/order
const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

if (HOOK_ORDER === 'after') registerHook()

const { buildSchema, graphql } = require('graphql')

const finish = require('../finish')

assert.strictEqual(globalThis.hookTransformed, true)

const schema = buildSchema('type Query { hello: String }')

graphql({ schema, source: '{ hello }', rootValue: { hello: () => 'world' } }).then(finish)
