'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const sinon = require('sinon')

const CHANNEL = 'dd-trace:bundler:load'

describe('bundler register', () => {
  let originalRequire

  beforeEach(() => {
    originalRequire = Module.prototype.require
  })

  afterEach(() => {
    Module.prototype.require = originalRequire
    sinon.restore()
  })

  it('honors patchDefault when applying an ESM proxy update', () => {
    const Original = class Original {}
    const Patched = class Patched {}
    const hook = sinon.stub().returns(Patched)
    const apply = sinon.stub()
    const { loadChannel, publish } = loadBundlerRegister({
      hooks: { 'test-default-export': sinon.stub() },
      instrumentations: {
        'test-default-export': [{ file: 'index.mjs', hook, patchDefault: true }],
      },
    })

    publish({
      apply,
      module: { default: Original },
      package: 'test-default-export',
      path: 'test-default-export/index.mjs',
      version: '1.0.0',
    })

    sinon.assert.calledOnceWithExactly(hook, Original, '1.0.0')
    sinon.assert.calledOnceWithExactly(apply, Patched, true)
    sinon.assert.calledOnceWithExactly(loadChannel.publish, {
      file: 'index.mjs',
      name: 'test-default-export',
      version: '1.0.0',
    })
  })

  it('patches a CommonJS object when its hook does not use a default export', () => {
    const Original = class Original {}
    const Patched = class Patched {}
    const hook = sinon.stub().returns(Patched)
    const { publish } = loadBundlerRegister({
      hooks: { 'test-commonjs-export': sinon.stub() },
      instrumentations: {
        'test-commonjs-export': [{ file: 'index.js', hook, patchDefault: false }],
      },
    })
    const payload = {
      module: { Original },
      package: 'test-commonjs-export',
      path: 'test-commonjs-export/index.js',
      version: '1.0.0',
    }

    publish(payload)

    sinon.assert.calledOnceWithExactly(hook, { Original }, '1.0.0')
    assert.equal(payload.module, Patched)
  })

  it('does not activate explicitly disabled bundled integrations', () => {
    const hook = sinon.stub()
    const integrationHook = sinon.stub()
    const { publish } = loadBundlerRegister({
      disabled: new Set(['test-disabled-integration']),
      hooks: { 'test-disabled-integration': hook },
      instrumentations: {
        'test-disabled-integration': [{ hook: integrationHook }],
      },
    })

    publish({
      module: {},
      package: 'test-disabled-integration',
      path: 'test-disabled-integration',
      version: '1.0.0',
    })

    sinon.assert.notCalled(hook)
    sinon.assert.notCalled(integrationHook)
  })

  it('matches bundled file-pattern hooks', () => {
    const hook = sinon.stub()
    const integrationHook = sinon.stub()
    const { publish } = loadBundlerRegister({
      hooks: { 'test-pattern-hook': hook },
      instrumentations: {
        'test-pattern-hook': [{ filePattern: 'dist/cli.*', hook: integrationHook }],
      },
    })

    publish({
      module: {},
      package: 'test-pattern-hook',
      path: 'test-pattern-hook/dist/cli-123.js',
      version: '1.0.0',
    })

    sinon.assert.calledOnceWithExactly(integrationHook, {}, '1.0.0')
  })

  it('matches bundled relative-module hooks', () => {
    const hook = sinon.stub()
    const integrationHook = sinon.stub()
    const { publish } = loadBundlerRegister({
      hooks: { './runtime/library.js': hook },
      instrumentations: {
        './runtime/library.js': [{ file: 'runtime/library.js', hook: integrationHook }],
      },
    })

    publish({
      module: {},
      package: './runtime/library.js',
      path: './runtime/library.js',
      version: '6.1.0',
    })

    sinon.assert.calledOnceWithExactly(integrationHook, {}, '6.1.0')
  })
})

function loadBundlerRegister ({ disabled = new Set(), hooks, instrumentations }) {
  const bundlerRegisterPath = require.resolve('../../src/helpers/bundler-register')
  const originalRequire = Module.prototype.require
  const loadChannel = { publish: sinon.stub() }
  let bundledModuleSubscriber
  const register = {
    filename: (name, file) => file ? `${name}/${file}` : name,
    loadChannel,
    matchVersion: () => true,
  }

  Module.prototype.require = function (request) {
    if (this.filename === bundlerRegisterPath) {
      const stubs = {
        './hooks': hooks,
        './instrumentation-utils': { getDisabledInstrumentations: () => disabled },
        './instrumentations': instrumentations,
        './register.js': register,
        '../../../dd-trace/src/log': { error: sinon.stub() },
        'dc-polyfill': {
          subscribe: (channel, callback) => {
            if (channel === CHANNEL) bundledModuleSubscriber = callback
          },
        },
      }
      return stubs[request] || originalRequire.call(this, request)
    }
    return originalRequire.call(this, request)
  }
  delete require.cache[bundlerRegisterPath]
  require('../../src/helpers/bundler-register')
  Module.prototype.require = originalRequire

  return {
    loadChannel,
    publish: message => bundledModuleSubscriber(message),
  }
}
