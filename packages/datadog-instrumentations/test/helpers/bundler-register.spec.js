'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const sinon = require('sinon')

const instrumentationUtils = require('../../src/helpers/instrumentation-utils')

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
      moduleBaseDir: '/app/node_modules/test-default-export',
      moduleName: 'test-default-export/index.mjs',
      package: 'test-default-export',
      path: 'test-default-export/index.mjs',
      version: '1.0.0',
    })

    sinon.assert.calledOnceWithExactly(hook, Original, '1.0.0', false, {
      moduleBaseDir: '/app/node_modules/test-default-export',
      moduleName: 'test-default-export/index.mjs',
    })
    sinon.assert.calledOnceWithExactly(apply, Patched, true)
    sinon.assert.calledOnceWithExactly(loadChannel.publish, { name: 'test-default-export' })
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

    sinon.assert.calledOnceWithExactly(hook, { Original }, '1.0.0', false, {
      moduleBaseDir: undefined,
      moduleName: 'test-commonjs-export/index.js',
    })
    assert.equal(payload.module, Patched)
  })

  it('does not activate explicitly disabled bundled integrations', () => {
    const hook = sinon.stub()
    const integrationHook = sinon.stub()
    const { loadChannel, publish } = loadBundlerRegister({
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

    sinon.assert.notCalled(loadChannel.publish)
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

    sinon.assert.calledOnceWithExactly(integrationHook, {}, '1.0.0', false, {
      moduleBaseDir: undefined,
      moduleName: 'test-pattern-hook/dist/cli-123.js',
    })
  })

  it('matches bundled relative-module hooks', () => {
    const hook = sinon.stub()
    const integrationHook = sinon.stub()
    const { publish } = loadBundlerRegister({
      hooks: { '@prisma/client': hook },
      instrumentations: {
        './runtime/library.js': [{ file: 'runtime/library.js', hook: integrationHook }],
      },
    })

    publish({
      integration: '@prisma/client',
      module: {},
      package: './runtime/library.js',
      path: './runtime/library.js',
      version: '6.1.0',
    })

    sinon.assert.calledOnceWithExactly(integrationHook, {}, '6.1.0', false, {
      moduleBaseDir: undefined,
      moduleName: './runtime/library.js',
    })
    sinon.assert.calledOnce(hook)
  })

  it('disables relative hooks through their owning integration', () => {
    const previous = process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = '@prisma/client'
    const hook = sinon.stub()
    const integrationHook = sinon.stub()

    try {
      const { loadChannel, publish } = loadBundlerRegister({
        disabled: instrumentationUtils.getDisabledInstrumentations(),
        hooks: { '@prisma/client': hook },
        instrumentations: {
          './runtime/library.js': [{ file: 'runtime/library.js', hook: integrationHook }],
        },
      })

      publish({
        integration: '@prisma/client',
        module: {},
        package: './runtime/library.js',
        path: './runtime/library.js',
        version: '6.1.0',
      })

      sinon.assert.notCalled(loadChannel.publish)
      sinon.assert.notCalled(hook)
      sinon.assert.notCalled(integrationHook)
    } finally {
      if (previous === undefined) delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      else process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = previous
    }
  })

  it('matches current hook metadata instead of stale build-plan positions', () => {
    const skippedHook = sinon.stub()
    const selectedHook = sinon.stub()
    const { publish } = loadBundlerRegister({
      hooks: { 'test-indexed-hook': sinon.stub() },
      instrumentations: {
        'test-indexed-hook': [
          { file: 'first.js', hook: skippedHook },
          { file: 'second.js', hook: selectedHook },
        ],
      },
    })

    publish({
      instrumentationIndexes: [0],
      module: {},
      package: 'test-indexed-hook',
      path: 'test-indexed-hook/second.js',
      version: '1.0.0',
    })

    sinon.assert.notCalled(skippedHook)
    sinon.assert.calledOnce(selectedHook)
  })

  it('rejects unmatched paths and incompatible versions', () => {
    const integrationHook = sinon.stub()
    const { publish } = loadBundlerRegister({
      hooks: { 'test-stale-plan': sinon.stub() },
      instrumentations: {
        'test-stale-plan': [{ file: 'index.js', hook: integrationHook, versions: ['>=2'] }],
      },
    })

    publish({
      module: {},
      package: 'test-stale-plan',
      path: 'test-stale-plan/other.js',
      version: '2.0.0',
    })
    publish({
      module: {},
      package: 'test-stale-plan',
      path: 'test-stale-plan/index.js',
      version: '1.0.0',
    })
    sinon.assert.notCalled(integrationHook)
  })

  it('contains non-Error loader and instrumentation failures', () => {
    const loadHook = sinon.stub().callsFake(() => throwValue('load failed'))
    const integrationHook = sinon.stub().callsFake(() => throwValue('patch failed'))
    const { log, publish } = loadBundlerRegister({
      hooks: { 'test-hook-errors': loadHook },
      instrumentations: {
        'test-hook-errors': [{ hook: integrationHook }],
      },
    })

    publish({
      module: {},
      package: 'test-hook-errors',
      path: 'test-hook-errors',
      version: '1.0.0',
    })

    sinon.assert.calledWithMatch(log.error, 'esbuild-wrapped %s hook failed: %s', 'test-hook-errors', 'load failed')
    sinon.assert.calledWithMatch(log.error, 'Error executing bundler hook: %s', 'patch failed')
  })

  it('does not apply an ESM hook without the export shape it expects', () => {
    const integrationHook = sinon.stub()
    const apply = sinon.stub()
    const { publish } = loadBundlerRegister({
      hooks: { 'test-missing-export': sinon.stub() },
      instrumentations: {
        'test-missing-export': [{ hook: integrationHook, patchDefault: false }],
      },
    })

    publish({
      apply,
      module: {},
      package: 'test-missing-export',
      path: 'test-missing-export',
      version: '1.0.0',
    })

    sinon.assert.notCalled(integrationHook)
    sinon.assert.notCalled(apply)
  })
})

/**
 * @param {unknown} value
 */
function throwValue (value) {
  throw value
}

function loadBundlerRegister ({ disabled = new Set(), hooks, instrumentations }) {
  const bundlerRegisterPath = require.resolve('../../src/helpers/bundler-register')
  const originalRequire = Module.prototype.require
  const loadChannel = { publish: sinon.stub() }
  const log = { error: sinon.stub() }
  const dc = {
    subscribe: (channel, callback) => {
      if (channel === CHANNEL) bundledModuleSubscriber = callback
    },
  }
  let bundledModuleSubscriber
  const register = { loadChannel }

  Module.prototype.require = function (request) {
    if (this.filename === bundlerRegisterPath) {
      const stubs = {
        './hooks': hooks,
        './instrumentation-utils': {
          ...instrumentationUtils,
          getDisabledInstrumentations: () => disabled,
        },
        './instrumentations': instrumentations,
        './register.js': register,
        '../../../dd-trace/src/log': log,
        'dc-polyfill': dc,
      }
      return stubs[request] || originalRequire.call(this, request)
    }
    return originalRequire.call(this, request)
  }
  delete require.cache[bundlerRegisterPath]
  require('../../src/helpers/bundler-register')
  Module.prototype.require = originalRequire

  return {
    dc,
    loadChannel,
    log,
    publish: message => bundledModuleSubscriber(message),
  }
}
