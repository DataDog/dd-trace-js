'use strict'

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

require('./setup/core')

describe('register.js', () => {
  let emitWarning

  beforeEach(() => {
    emitWarning = sinon.stub(process, 'emitWarning')
  })

  afterEach(() => {
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
      syncLoaderHooksSupported: () => false,
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.notCalled(supportsSyncHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.notCalled(emitWarning)
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
  })
})

function createThrowingLoaderHook (error) {
  return Object.defineProperty({}, 'registerSyncLoaderHooks', {
    get () {
      throw error
    },
  })
}

function loadRegister ({ register, registerSyncLoaderHooks, loaderHook, supportsSyncHooks, syncLoaderHooksSupported }) {
  proxyquire('../../../register.js', {
    'node:module': { register },
    'import-in-the-middle/create-hook.mjs': { supportsSyncHooks },
    './loader-hook.mjs': loaderHook || { registerSyncLoaderHooks },
    './packages/dd-trace/src/supported-loader-hooks': {
      syncLoaderHooksSupported: syncLoaderHooksSupported || (() => true),
    },
  })
}
