'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

require('./setup/core')

const SUPPORTED_SYNC_HOOKS_NODE_VERSION = {
  NODE_MAJOR: 24,
  NODE_MINOR: 11,
  NODE_PATCH: 1,
}
const FULL_SYNC_LOADER_SYMBOL = Symbol.for('dd-trace.loader.full-sync')

describe('register.js', () => {
  let emitWarning

  beforeEach(() => {
    delete globalThis[FULL_SYNC_LOADER_SYMBOL]
    emitWarning = sinon.stub(process, 'emitWarning')
  })

  afterEach(() => {
    delete globalThis[FULL_SYNC_LOADER_SYMBOL]
    emitWarning.restore()
  })

  it('falls back to the async loader on unsupported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)
    const supportsSyncHooks = sinon.stub().throws(new Error('should not be called'))

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks,
      version: {
        NODE_MAJOR: 24,
        NODE_MINOR: 11,
        NODE_PATCH: 0,
      },
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.notCalled(supportsSyncHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.notCalled(emitWarning)
    assertFullSyncLoaderInactive()
  })

  it('registers sync loader hooks on supported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.notCalled(register)
    sinon.assert.notCalled(emitWarning)
    assert.strictEqual(globalThis[FULL_SYNC_LOADER_SYMBOL], true)
  })

  it('falls back to the async loader on the last Electron without the validator fix', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)
    const supportsSyncHooks = sinon.stub().throws(new Error('should not be called'))

    // Electron's `electron:electron` modules make Node reject the default load
    // step as soon as any load hook is registered.
    withElectronVersion('42.8.1', () => {
      loadRegister({ register, registerSyncLoaderHooks, supportsSyncHooks })
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.notCalled(supportsSyncHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.notCalled(emitWarning)
    assertFullSyncLoaderInactive()
  })

  it('registers sync loader hooks on the first Electron with the validator fix', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    // Electron 43.0.0 exempts `electron:` URLs from the strict source validation.
    withElectronVersion('43.0.0', () => {
      loadRegister({ register, registerSyncLoaderHooks, supportsSyncHooks: () => true })
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.notCalled(register)
    sinon.assert.notCalled(emitWarning)
    assert.strictEqual(globalThis[FULL_SYNC_LOADER_SYMBOL], true)
  })

  it('warns and falls back if sync loader registration returns false', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(false)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(emitWarning, /dd-trace could not register synchronous loader hooks/)
    assertFullSyncLoaderInactive()
  })

  it('warns and falls back if sync loader registration throws', () => {
    const error = new Error('sync hook failure')
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().throws(error)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*sync hook failure/
    )
    assertFullSyncLoaderInactive()
  })

  it('falls back to the async loader if require(esm) is disabled', () => {
    const register = sinon.stub()
    const error = new Error('require(esm) is disabled')
    error.code = 'ERR_REQUIRE_ESM'

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*require\(esm\) is disabled/
    )
    assertFullSyncLoaderInactive()
  })

  it('warns and falls back if sync loader import fails', () => {
    const register = sinon.stub()
    const error = new Error('loader import failure')

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*loader import failure/
    )
    assertFullSyncLoaderInactive()
  })

  it('warns and falls back if sync hook support detection fails', () => {
    const register = sinon.stub()
    const error = new Error('support detection failure')

    loadRegister({
      register,
      supportsSyncHooks: () => { throw error },
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*support detection failure/
    )
    assertFullSyncLoaderInactive()
  })
})

function assertFullSyncLoaderInactive () {
  assert.strictEqual(globalThis[FULL_SYNC_LOADER_SYMBOL], undefined)
}

function withElectronVersion (version, fn) {
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: version })

  try {
    fn()
  } finally {
    delete process.versions.electron
  }
}

function createThrowingLoaderHook (error) {
  return Object.defineProperty({}, 'registerSyncLoaderHooks', {
    get () {
      throw error
    },
  })
}

function loadRegister ({ register, registerSyncLoaderHooks, loaderHook, supportsSyncHooks, version }) {
  proxyquire('../../../register.js', {
    'node:module': { register },
    'import-in-the-middle/create-hook.mjs': { supportsSyncHooks },
    './loader-hook.mjs': loaderHook || { registerSyncLoaderHooks },
    './packages/datadog-instrumentations/src/helpers/rewriter/loader.js': {},
    './version': version || SUPPORTED_SYNC_HOOKS_NODE_VERSION,
  })
}
