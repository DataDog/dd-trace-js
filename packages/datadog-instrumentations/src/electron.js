'use strict'

const { mkdtempSync, readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const { wrap } = require('../../datadog-shimmer')
const { addHook, channel, tracingChannel } = require('./helpers/instrument')

const requestCh = tracingChannel('apm:electron:net:request')
const mainReceiveCh = tracingChannel('apm:electron:ipc:main:receive')
const mainHandleCh = tracingChannel('apm:electron:ipc:main:handle')
const mainSendCh = tracingChannel('apm:electron:ipc:main:send')
const rendererPatchedCh = channel('apm:electron:ipc:renderer:patched')
const rendererReceiveCh = tracingChannel('apm:electron:ipc:renderer:receive')
const rendererSendCh = tracingChannel('apm:electron:ipc:renderer:send')

const listeners = {}
const handlers = {}

function createWrapRequest (ch) {
  return function wrapRequest (request) {
    return function (...args) {
      if (!ch.start.hasSubscribers) return request.apply(this, arguments)

      const ctx = { args }

      return ch.start.runStores(ctx, () => {
        try {
          const req = request.apply(this, ctx.args)
          const emit = req.emit

          ctx.req = req

          req.emit = function (eventName, arg) {
            /* eslint-disable no-fallthrough */
            switch (eventName) {
              case 'response':
                ctx.res = arg
                ctx.res.on('error', error => {
                  ctx.error = error
                  ch.error.publish(ctx)
                  ch.asyncStart.publish(ctx)
                })
                ctx.res.on('end', () => ch.asyncStart.publish(ctx))
                break
              case 'error':
                ctx.error = arg
                ch.error.publish(ctx)
              case 'abort':
                ch.asyncStart.publish(ctx)
            }

            return emit.apply(this, arguments)
          }

          return req
        } catch (e) {
          ctx.error = e
          ch.error.publish(ctx)
          throw e
        } finally {
          ch.end.publish(ctx)
        }
      })
    }
  }
}

function createWrapAddListener (ch, mappings) {
  return function wrapAddListener (addListener) {
    return function (channel, listener) {
      const wrappedListener = (event, ...args) => {
        const ctx = { args, channel, event }

        return ch.tracePromise(() => listener.call(this, event, ...args), ctx)
      }

      const mapping = mappings[channel] || new WeakMap()
      const wrapper = mapping.get(listener) || wrappedListener

      mapping.set(listener, wrapper)

      return addListener.call(this, channel, wrappedListener)
    }
  }
}

function createWrapRemoveListener (mappings) {
  return function wrapRemoveListener (removeListener) {
    return function (channel, listener) {
      const mapping = mappings[channel]

      if (mapping) {
        const wrapper = mapping.get(listener)

        if (wrapper) {
          return removeListener.call(this, channel, wrapper)
        }
      }

      return removeListener.call(this, channel, listener)
    }
  }
}

function createWrapRemoveAllListeners (mappings) {
  return function wrapRemoveAllListeners (removeAllListeners) {
    return function (channel) {
      if (channel) {
        delete mappings[channel]
      } else {
        Object.keys(mappings).forEach(key => delete mappings[key])
      }

      return removeAllListeners.apply(this, channel)
    }
  }
}

function createWrapSend (ch, promise = false) {
  const trace = (promise ? ch.tracePromise : ch.traceSync).bind(ch)

  return function wrapSend (send) {
    return function (channel, ...args) {
      const ctx = { args, channel, self: this }

      return trace(() => send.call(this, channel, ...args), ctx)
    }
  }
}

function wrapSendToFrame (send) {
  return function (frameId, channel, ...args) {
    const ctx = { args, channel, frameId, self: this }

    return mainSendCh.traceSync(() => send.call(this, frameId, channel, ...args), ctx)
  }
}

function wrapBrowserWindow (electron) {
  const moduleExports = {}

  class DatadogBrowserWindow extends electron.BrowserWindow {
    constructor (options = {}) {
      const webPreferences = options.webPreferences ??= {}
      const preload = options.webPreferences.preload
      const ddPreload = join(__dirname, 'electron', 'preload.js')

      if (preload) {
        const userCode = readFileSync(preload, 'utf8')
        const ddCode = ';(() => {' + readFileSync(ddPreload, 'utf8') + '})();'
        const useStrict = userCode.match(/['"]use strict['"]/)?.[0] || ''
        const tmp = electron.app.getPath('temp')
        const dir = mkdtempSync(join(tmp, 'dd-electron-preload-'))
        const filename = join(dir, 'preload.js')

        // Preload doesn't support `require` of relative paths in sandboxed mode
        // so we merge our preload with the user preload in a single file.
        writeFileSync(filename, useStrict + '\n' + ddCode + '\n' + userCode)

        webPreferences.preload = filename
      } else {
        webPreferences.preload = ddPreload
      }

      // BrowserWindow doesn't support subclassing because it's all native code
      // so we return an instance of it instead of the subclass.
      return super(options) // eslint-disable-line constructor-super
    }
  }

  Object.defineProperty(moduleExports, 'BrowserWindow', {
    enumerable: true,
    get: () => DatadogBrowserWindow,
    configurable: false
  })

  for (const key of Reflect.ownKeys(electron)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(electron, key)

    if (key === 'BrowserWindow') continue

    Object.defineProperty(moduleExports, key, descriptor)
  }

  return moduleExports
}

function wrapWebContents (proto) {
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'webContents')
  const wrapped = new WeakSet()
  const wrapSend = createWrapSend(mainSendCh)

  Object.defineProperty(proto, 'webContents', {
    get () {
      const webContents = descriptor.get.apply(this)

      if (!wrapped.has(webContents)) {
        // wrap(webContents, 'postMessage', wrapSend)
        wrap(webContents, 'send', wrapSend)
        wrap(webContents, 'sendToFrame', wrapSendToFrame)

        wrapped.add(webContents)
      }

      return webContents
    }
  })
}

addHook({ name: 'electron', versions: ['>=37.0.0'] }, electron => {
  // Electron exports a string in Node and an object in Electron.
  if (typeof electron === 'string') return electron

  const { BrowserWindow, ipcMain, ipcRenderer, net } = electron

  if (net) {
    // This also covers `fetch` as it uses `request` under the hood.
    wrap(net, 'request', createWrapRequest(requestCh))
  }

  if (ipcRenderer) {
    wrap(ipcRenderer, 'invoke', createWrapSend(rendererSendCh, true))
    // wrap(ipcRenderer, 'postMessage', createWrapSend(rendererSendCh))
    wrap(ipcRenderer, 'send', createWrapSend(rendererSendCh))
    wrap(ipcRenderer, 'sendSync', createWrapSend(rendererSendCh))
    wrap(ipcRenderer, 'sendToHost', createWrapSend(rendererSendCh))

    wrap(ipcRenderer, 'addListener', createWrapAddListener(rendererReceiveCh, listeners))
    wrap(ipcRenderer, 'off', createWrapRemoveListener(listeners))
    wrap(ipcRenderer, 'on', createWrapAddListener(rendererReceiveCh, listeners))
    wrap(ipcRenderer, 'once', createWrapAddListener(rendererReceiveCh, listeners))
    wrap(ipcRenderer, 'removeListener', createWrapRemoveListener(listeners))
    wrap(ipcRenderer, 'removeAllListeners', createWrapRemoveAllListeners(listeners))

    ipcRenderer.send('datadog:apm:renderer:patched')
  } else {
    wrap(ipcMain, 'addListener', createWrapAddListener(mainReceiveCh, listeners))
    wrap(ipcMain, 'handle', createWrapAddListener(mainHandleCh, handlers))
    wrap(ipcMain, 'handleOnce', createWrapAddListener(mainHandleCh, handlers))
    wrap(ipcMain, 'off', createWrapRemoveListener(listeners))
    wrap(ipcMain, 'on', createWrapAddListener(mainReceiveCh, listeners))
    wrap(ipcMain, 'once', createWrapAddListener(mainReceiveCh, listeners))
    wrap(ipcMain, 'removeAllListeners', createWrapRemoveAllListeners(listeners))
    wrap(ipcMain, 'removeHandler', createWrapRemoveAllListeners(handlers))
    wrap(ipcMain, 'removeListener', createWrapRemoveListener(listeners))

    ipcMain.once('datadog:apm:renderer:patched', event => rendererPatchedCh.publish(event))

    wrapWebContents(BrowserWindow.prototype)

    electron = wrapBrowserWindow(electron)
  }

  return electron
})
