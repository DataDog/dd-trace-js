'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

require('./setup/core')

describe('register.js', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('falls back to the async loader on unsupported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      version: { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 0 },
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
  })

  it('falls back to the async loader on Node.js versions predating module.registerHooks', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      version: { NODE_MAJOR: 20, NODE_MINOR: 19, NODE_PATCH: 0 },
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
  })

  it('registers sync loader hooks on supported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      version: { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 },
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.notCalled(register)
  })

  it('warns and falls back to the async loader if sync loader registration returns false', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(false)
    const emitWarning = sinon.stub(process, 'emitWarning')

    loadRegister({
      register,
      registerSyncLoaderHooks,
      version: { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 },
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithMatch(emitWarning, /could not; falling back to the asynchronous loader/)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
  })

  it('throws sync loader registration errors on supported Node.js versions', () => {
    const error = new Error('sync hook failure')
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().throws(error)

    assert.throws(() => {
      loadRegister({
        register,
        registerSyncLoaderHooks,
        version: { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 },
      })
    }, error)

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.notCalled(register)
  })

  it('falls back to the async loader if require(esm) is disabled', () => {
    const register = sinon.stub()
    const error = new Error('require(esm) is disabled')
    error.code = 'ERR_REQUIRE_ESM'

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      version: { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 },
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
  })

  it('throws other sync loader import errors on supported Node.js versions', () => {
    const register = sinon.stub()
    const error = new Error('loader import failure')

    assert.throws(() => {
      loadRegister({
        register,
        loaderHook: createThrowingLoaderHook(error),
        version: { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 },
      })
    }, error)

    sinon.assert.notCalled(register)
  })
})

function createThrowingLoaderHook (error) {
  return Object.defineProperty({}, 'registerSyncLoaderHooks', {
    get () {
      throw error
    },
  })
}

function loadRegister ({ register, registerSyncLoaderHooks, loaderHook, version }) {
  proxyquire('../../../register.js', {
    'node:module': { register },
    './loader-hook.mjs': loaderHook || { registerSyncLoaderHooks },
    './version': version,
  })
}
