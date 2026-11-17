'use strict'

const { MessagePort } = require('node:worker_threads')

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

require('./setup/core')

const SUPPORTED_SYNC_HOOKS_NODE_VERSION = {
  NODE_MAJOR: 24,
  NODE_MINOR: 11,
  NODE_PATCH: 1,
}

// The asynchronous loader receives the port it reports unwrapped module loads through.
const asyncLoaderOptions = sinon.match({
  data: { moduleLoadPort: sinon.match.instanceOf(MessagePort) },
  transferList: sinon.match.array,
})

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

    loadRegister({
      register,
      registerSyncLoaderHooks,
      version: {
        NODE_MAJOR: 24,
        NODE_MINOR: 11,
        NODE_PATCH: 0,
      },
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.notCalled(emitWarning)
  })

  it('registers sync loader hooks on supported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register,
      registerSyncLoaderHooks,
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
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(emitWarning, /dd-trace could not register synchronous loader hooks/)
  })

  it('warns and falls back if sync loader registration throws', () => {
    const error = new Error('sync hook failure')
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().throws(error)

    loadRegister({
      register,
      registerSyncLoaderHooks,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*sync hook failure/
    )
  })

  it('warns and falls back if sync loader import fails', () => {
    const register = sinon.stub()
    const error = new Error('loader import failure')

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*loader import failure/
    )
  })

  it('registers sync loader hooks when module.register is unavailable', () => {
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register: undefined,
      registerSyncLoaderHooks,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.notCalled(emitWarning)
  })

  it('warns when synchronous registration fails and module.register is unavailable', () => {
    loadRegister({
      register: undefined,
      registerSyncLoaderHooks: sinon.stub().throws(new Error('sync hook failure')),
    })

    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /ESM instrumentation is unavailable.*sync hook failure/
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

function loadRegister ({ register, registerSyncLoaderHooks, loaderHook, version }) {
  proxyquire('../../../register.js', {
    'node:module': { register },
    './loader-hook.js': loaderHook || { registerSyncLoaderHooks },
    './version': version || SUPPORTED_SYNC_HOOKS_NODE_VERSION,
  })
}
