'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const proxyquire = require('proxyquire').noCallThru()
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
    const moduleExports = { original: true }
    const hook = sinon.stub().callsFake(exports => {
      exports.patched = true
    })
    const { loadChannel, publish } = loadBundlerRegister({
      hooks: { 'test-commonjs-export': sinon.stub() },
      instrumentations: {
        'test-commonjs-export': [{ file: 'index.js', hook }],
      },
    })
    const payload = {
      module: moduleExports,
      package: 'test-commonjs-export',
      path: 'test-commonjs-export/index.js',
      version: '1.0.0',
    }

    publish(payload)

    sinon.assert.calledOnceWithExactly(hook, moduleExports, '1.0.0')
    sinon.assert.calledOnceWithExactly(loadChannel.publish, { name: 'test-commonjs-export' })
    assert.strictEqual(payload.module, moduleExports)
    assert.equal(payload.module.patched, true)
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
    sinon.assert.callOrder(hook, loadChannel.publish, integrationHook)
    sinon.assert.notCalled(duplicateHook)
    sinon.assert.notCalled(ordinaryHook)
    assert.equal(Object.hasOwn(payload, 'module'), false)
  })

  it('activates a hookless source-rewritten integration without loading a hook', () => {
    const { loadChannel, log, publish } = loadBundlerRegister({
      rewriteActivationEnabled: new Set(['test-hookless']),
      hooks: {},
      instrumentations: {},
    })

    publish({
      activate: true,
      package: 'test-hookless',
      path: 'test-hookless/index.js',
      version: '1.0.0',
    })

    sinon.assert.calledOnceWithExactly(loadChannel.publish, { name: 'test-hookless' })
    sinon.assert.notCalled(log.error)
  })

  it('passes metadata to activation setup before publishing for every bundled module in a group', () => {
    const setup = sinon.stub()
    const { activate, loadChannel, log, publish } = loadBundlerRegister({
      rewriteActivationEnabled: new Set(['first', 'second']),
      activationSetups: new Map([['first', setup], ['second', setup]]),
      hooks: {},
      instrumentations: {},
    })

    publish({ activate: true, package: 'first', version: '1.0.0' })
    publish({ activate: true, package: 'second', version: '2.0.0' })
    publish({ activate: true, package: 'first', version: '1.0.1' })

    assert.deepStrictEqual(setup.args, [
      [{ moduleName: 'first', version: '1.0.0' }],
      [{ moduleName: 'second', version: '2.0.0' }],
      [{ moduleName: 'first', version: '1.0.1' }],
    ])
    sinon.assert.callOrder(setup, loadChannel.publish)
    assert.ok(setup.getCall(1).calledBefore(loadChannel.publish.getCall(1)))
    assert.ok(setup.getCall(2).calledBefore(loadChannel.publish.getCall(2)))
    assert.deepStrictEqual(activate.args, [['first', '1.0.0'], ['second', '2.0.0'], ['first', '1.0.1']])
    assert.deepStrictEqual(loadChannel.publish.args,
      [[{ name: 'first' }], [{ name: 'second' }], [{ name: 'first' }]])
    sinon.assert.notCalled(log.error)
  })

  it('does not publish or retry bundled group activation when setup fails', () => {
    const error = new Error('setup failed')
    const setup = sinon.stub().throws(error)
    const { loadChannel, log, publish, telemetry } = loadBundlerRegister({
      rewriteActivationEnabled: new Set(['first', 'second']),
      activationSetups: new Map([['first', setup], ['second', setup]]),
      hooks: {},
      instrumentations: {},
    })

    publish({ activate: true, package: 'first' })
    publish({ activate: true, package: 'second' })
    publish({ activate: true, package: 'first' })

    sinon.assert.calledOnceWithExactly(setup, { moduleName: 'first', version: undefined })
    sinon.assert.notCalled(loadChannel.publish)
    sinon.assert.calledOnceWithExactly(log.error,
      'Error during activation setup of %s: %s', 'first', 'setup failed', error)
    sinon.assert.calledOnceWithExactly(telemetry, 'error', [
      'error_type:Error', 'integration:first', 'integration_version:unknown',
    ], {
      result: 'error',
      result_class: 'internal_error',
      result_reason: 'Error during activation of first: setup failed',
    })
  })

  it('does not activate a disabled hookless source-rewritten integration', () => {
    const setup = sinon.stub()
    const { loadChannel, publish } = loadBundlerRegister({
      disabled: new Set(['test-hookless']),
      rewriteActivationEnabled: new Set(['test-hookless']),
      activationSetups: new Map([['test-hookless', setup]]),
      hooks: {},
      instrumentations: {},
    })

    publish({ activate: true, package: 'test-hookless' })

    sinon.assert.notCalled(loadChannel.publish)
    sinon.assert.notCalled(setup)
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
    const activationHook = sinon.stub().callsFake(() => throwValue('activation failed'))
    const { log, publish } = loadBundlerRegister({
      hooks: { 'test-hook-errors': loadHook },
      instrumentations: {
        'test-activation-errors': [{
          hook: activationHook,
          sourceRewrite: 'dist/index.js',
          versions: ['1'],
        }],
        'test-hook-errors': [{ hook: integrationHook }],
      },
    })

    publish({
      activate: true,
      package: 'test-activation-errors',
      path: 'test-activation-errors/dist/index.js',
      version: '1.0.0',
    })
    publish({
      module: {},
      package: 'test-hook-errors',
      path: 'test-hook-errors',
      version: '1.0.0',
    })

    sinon.assert.calledWithMatch(log.error, 'esbuild-wrapped %s hook failed: %s', 'test-hook-errors', 'load failed')
    sinon.assert.calledWithMatch(log.error, 'Error executing bundler hook: %s', 'activation failed')
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
 *   rewriteActivationEnabled?: Set<string>,
 *   activationSetups?: Map<string, (activation: { moduleName: string, version?: string }) => void>,
 *   hooks: Record<string, Function|{ fn: Function }>,
 *   instrumentations: Record<string, Array<object>>
 * }} options
 */
function loadBundlerRegister ({
  disabled = new Set(),
  rewriteActivationEnabled = new Set(),
  activationSetups = new Map(),
  hooks,
  instrumentations,
}) {
  const bundlerRegisterPath = require.resolve('../../src/helpers/bundler-register')
  const originalRequire = Module.prototype.require
  const loadChannel = { publish: sinon.stub() }
  const log = { error: sinon.stub() }
  const telemetry = sinon.stub()
  const dc = {
    subscribe: (channel, callback) => {
      if (channel === CHANNEL) bundledModuleSubscriber = callback
    },
  }
  let bundledModuleSubscriber
  const register = proxyquire('../../src/helpers/register', {
    './hooks': {},
    './hook': sinon.stub(),
    './instrumentations': {},
    './instrumentation-utils': {
      ...instrumentationUtils,
      getDisabledInstrumentations: () => disabled,
    },
    './check-require-cache': { checkForRequiredModules: sinon.stub(), checkForPotentialConflicts: sinon.stub() },
    './rewriter': { disable: sinon.stub() },
    './rewriter/instrumentation-registry': { getActivationSetup: name => activationSetups.get(name) },
    '../fetch': {},
    '../process': {},
    '../console': {},
    '../../../dd-trace/src/log': log,
    '../../../dd-trace/src/guardrails/telemetry': telemetry,
    'dc-polyfill': {
      channel: name => name === 'dd-trace:instrumentation:load' ? loadChannel : { subscribe: sinon.stub() },
    },
  })
  const activate = sinon.spy(register, 'activate')

  Module.prototype.require = function (request) {
    if (this.filename === bundlerRegisterPath) {
      const stubs = {
        './hooks': hooks,
        './instrumentation-utils': {
          ...instrumentationUtils,
          getDisabledInstrumentations: () => disabled,
        },
        './instrumentations': instrumentations,
        './rewriter/targets': {
          isRewriteActivationEnabled: name => rewriteActivationEnabled.has(name),
        },
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
    activate,
    dc,
    loadChannel,
    log,
    telemetry,
    publish: message => bundledModuleSubscriber(message),
  }
}
