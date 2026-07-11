'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

describe('bundler-register', () => {
  it('forwards bundler ownership metadata to instrumentation hooks', () => {
    let subscriber
    const originalModule = {}
    const hook = sinon.stub()
    const loadChannel = { publish: sinon.spy() }
    proxyquire('../../src/helpers/bundler-register', {
      'dc-polyfill': {
        subscribe: (name, callback) => {
          assert.strictEqual(name, 'dd-trace:bundler:load')
          subscriber = callback
        },
      },
      './hooks': {
        '@opentelemetry/api': () => {},
      },
      './instrumentations': {
        '@opentelemetry/api': [{
          hook,
          versions: ['>=1'],
        }],
      },
      './register.js': {
        filename: name => name,
        loadChannel,
        matchVersion: () => true,
      },
    })
    const payload = {
      applicationOwned: false,
      module: originalModule,
      moduleBaseDir: '/app/node_modules/@opentelemetry/api',
      package: '@opentelemetry/api',
      path: '@opentelemetry/api',
      version: '1.9.0',
    }

    subscriber(payload)

    sinon.assert.calledOnceWithExactly(hook, originalModule, '1.9.0', false, {
      applicationOwned: false,
      moduleBaseDir: '/app/node_modules/@opentelemetry/api',
    })
    sinon.assert.calledOnceWithExactly(loadChannel.publish, {
      file: undefined,
      name: '@opentelemetry/api',
      version: '1.9.0',
    })
    assert.strictEqual(payload.module, originalModule)
  })
})
