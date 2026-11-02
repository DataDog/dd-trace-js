'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const preloadPath = path.join(__dirname, '..', '..', 'src', 'electron', 'preload.js')

describe('electron preload registration', () => {
  let hook

  beforeEach(() => {
    const realInstrument = require('../../src/helpers/instrument')
    const addHook = sinon.spy()

    proxyquire('../../src/electron', {
      './helpers/instrument': { ...realInstrument, addHook },
    })

    hook = addHook.getCalls().find(({ args }) => args[0].name === 'electron').args[1]
  })

  function createSession () {
    return { registerPreloadScript: sinon.stub() }
  }

  function createElectron (existingSessions = []) {
    const app = new EventEmitter()
    const ipcMain = new EventEmitter()
    ipcMain.handle = sinon.stub()
    ipcMain.handleOnce = sinon.stub()
    ipcMain.removeHandler = sinon.stub()

    class BrowserWindow {}
    Object.defineProperty(BrowserWindow.prototype, 'webContents', { get: () => ({}), configurable: true })

    return {
      app,
      BrowserWindow,
      ipcMain,
      webContents: {
        getAllWebContents: () => existingSessions.map(session => ({ session })),
      },
    }
  }

  function assertPreloadRegistered (session) {
    sinon.assert.calledOnceWithExactly(session.registerPreloadScript, { type: 'frame', filePath: preloadPath })
  }

  it('returns the original exports so a previously cached namespace stays instrumented', () => {
    const electron = createElectron()

    assert.strictEqual(hook(electron), electron)
  })

  it('registers the preload on the session of each web contents created afterwards', () => {
    const electron = createElectron()
    const session = createSession()
    const partition = createSession()

    hook(electron)
    electron.app.emit('web-contents-created', {}, { session })
    electron.app.emit('web-contents-created', {}, { session: partition })

    assertPreloadRegistered(session)
    assertPreloadRegistered(partition)
  })

  it('registers the preload only once per session', () => {
    const electron = createElectron()
    const session = createSession()

    hook(electron)
    electron.app.emit('web-contents-created', {}, { session })
    electron.app.emit('web-contents-created', {}, { session })

    assertPreloadRegistered(session)
  })

  it('registers the preload on sessions already in use when instrumented late', () => {
    const session = createSession()
    const electron = createElectron([session, session])

    hook(electron)
    electron.app.emit('web-contents-created', {}, { session })

    assertPreloadRegistered(session)
  })

  it('does not register preloads outside of the main process', () => {
    const app = new EventEmitter()
    const net = { request () {} }

    hook({ app, net })

    assert.strictEqual(app.listenerCount('web-contents-created'), 0)
  })
})
