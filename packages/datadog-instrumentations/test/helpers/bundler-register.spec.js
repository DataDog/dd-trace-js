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

  it('patches modules published by existing bundlers', () => {
    const Original = class Original {}
    const Patched = class Patched {}
    const hook = sinon.stub().returns(Patched)
    const { loadChannel, publish } = loadBundlerRegister({
      hooks: { 'test-commonjs-export': sinon.stub() },
      instrumentations: {
        'test-commonjs-export': [{ file: 'index.js', hook }],
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
    sinon.assert.calledOnceWithExactly(loadChannel.publish, { name: 'test-commonjs-export' })
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

  it('activates a source-rewritten integration without patching exports', () => {
    const hook = sinon.stub()
    const integrationHook = sinon.stub()
    const duplicateHook = sinon.stub()
    const ordinaryHook = sinon.stub()
    const { loadChannel, publish } = loadBundlerRegister({
      hooks: { 'test-rewritten-integration': hook },
      instrumentations: {
        'test-rewritten-integration': [
          { file: 'dist/index.js', hook: ordinaryHook },
          { hook: integrationHook, sourceRewrite: 'dist/index.js', versions: ['>=1'] },
          { hook: duplicateHook, sourceRewrite: 'dist/index.js', versions: ['>=1'] },
        ],
      },
    })
    const payload = {
      activate: true,
      package: 'test-rewritten-integration',
      path: 'test-rewritten-integration/dist/index.js',
      version: '1.0.0',
    }

    publish(payload)

    sinon.assert.calledOnceWithExactly(hook)
    sinon.assert.calledOnceWithExactly(loadChannel.publish, { name: 'test-rewritten-integration' })
    sinon.assert.calledOnceWithExactly(integrationHook, undefined, '1.0.0')
    sinon.assert.notCalled(duplicateHook)
    sinon.assert.notCalled(ordinaryHook)
    assert.equal(Object.hasOwn(payload, 'module'), false)
  })

  it('does not report activation-only integrations as missing export hooks', () => {
    const activationHook = sinon.stub()
    const exportHook = sinon.stub()
    const { log, publish } = loadBundlerRegister({
      hooks: {
        'test-activation-only': activationHook,
        'test-missing-export-hook': exportHook,
      },
      instrumentations: {},
    })

    publish({
      activate: true,
      package: 'test-activation-only',
      path: 'test-activation-only/index.js',
      version: '1.0.0',
    })

    sinon.assert.notCalled(log.error)
    sinon.assert.calledOnceWithExactly(activationHook)

    publish({
      module: {},
      package: 'test-missing-export-hook',
      path: 'test-missing-export-hook',
      version: '1.0.0',
    })

    sinon.assert.calledOnceWithExactly(
      log.error,
      'esbuild-wrapped %s missing in list of instrumentations',
      'test-missing-export-hook'
    )
    sinon.assert.calledOnceWithExactly(exportHook)
  })

  it('patches file-pattern publications', () => {
    const integrationHook = sinon.stub().returns({ patched: true })
    const { publish } = loadBundlerRegister({
      hooks: { 'test-pattern': sinon.stub() },
      instrumentations: {
        'test-pattern': [{ filePattern: String.raw`lib/chunk-.*\.js`, hook: integrationHook }],
      },
    })
    const payload = {
      module: {},
      package: 'test-pattern',
      path: 'test-pattern/lib/chunk-one.js',
      version: '1.0.0',
    }

    publish(payload)

    sinon.assert.calledOnceWithExactly(integrationHook, {}, '1.0.0')
    assert.deepStrictEqual(payload.module, { patched: true })
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
})

/**
 * @param {unknown} value
 */
function throwValue (value) {
  throw value
}

/**
 * @param {{
 *   disabled?: Set<string>,
 *   hooks: Record<string, Function|{ fn: Function }>,
 *   instrumentations: Record<string, Array<object>>
 * }} options
 */
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
