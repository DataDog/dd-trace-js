'use strict'

const { join } = require('path')
const { tracingChannel, channel } = require('dc-polyfill')

const requestCh = tracingChannel('apm:electron:net:request')
const mainReceiveCh = tracingChannel('apm:electron:ipc:main:receive')
const mainHandleCh = tracingChannel('apm:electron:ipc:main:handle')
const mainSendCh = tracingChannel('apm:electron:ipc:main:send')
const rendererPatchedCh = channel('apm:electron:ipc:renderer:patched')
const rendererReceiveCh = tracingChannel('apm:electron:ipc:renderer:receive')
const rendererSendCh = tracingChannel('apm:electron:ipc:renderer:send')

const listeners = {}
const handlers = {}

function wrap (obj, method, wrapper) {
  obj[method] = wrapper(obj[method].bind(obj))
}

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
    return function (ipcChannel, listener) {
      const wrappedListener = (event, ...args) => {
        const ctx = { args, channel: ipcChannel, event }

        return ch.tracePromise(() => listener.call(this, event, ...args), ctx)
      }

      const mapping = mappings[ipcChannel] || new WeakMap()
      const wrapper = mapping.get(listener) || wrappedListener

      mapping.set(listener, wrapper)

      return addListener.call(this, ipcChannel, wrappedListener)
    }
  }
}

function createWrapRemoveListener (mappings) {
  return function wrapRemoveListener (removeListener) {
    return function (ipcChannel, listener) {
      const mapping = mappings[ipcChannel]

      if (mapping) {
        const wrapper = mapping.get(listener)

        if (wrapper) {
          return removeListener.call(this, ipcChannel, wrapper)
        }
      }

      return removeListener.call(this, ipcChannel, listener)
    }
  }
}

function createWrapRemoveAllListeners (mappings) {
  return function wrapRemoveAllListeners (removeAllListeners) {
    return function (ipcChannel) {
      if (ipcChannel) {
        delete mappings[ipcChannel]
      } else {
        for (const key of Object.keys(mappings)) delete mappings[key]
      }

      return removeAllListeners.call(this, ipcChannel)
    }
  }
}

function createWrapSend (ch, promise = false) {
  const trace = (promise ? ch.tracePromise : ch.traceSync).bind(ch)

  return function wrapSend (send) {
    return function (ipcChannel, ...args) {
      const ctx = { args, channel: ipcChannel, self: this }

      return trace(() => send.call(this, ipcChannel, ...args), ctx)
    }
  }
}

function wrapSendToFrame (send) {
  return function (frameId, ipcChannel, ...args) {
    const ctx = { args, channel: ipcChannel, frameId, self: this }

    return mainSendCh.traceSync(() => send.call(this, frameId, ipcChannel, ...args), ctx)
  }
}

function patchBrowserWindow (electron) {
  const OriginalBrowserWindow = electron.BrowserWindow

  class DatadogBrowserWindow extends OriginalBrowserWindow {
    constructor (options = {}) {
      const win = super(options)

      win.webContents.session.registerPreloadScript({
        type: 'frame',
        filePath: join(__dirname, 'preload.js'),
      })

      // BrowserWindow doesn't support subclassing because it's all native code
      // so we return an instance of it instead of the subclass.
      return win
    }
  }

  electron.BrowserWindow = DatadogBrowserWindow

  const descriptor = Object.getOwnPropertyDescriptor(OriginalBrowserWindow.prototype, 'webContents')
  const wrapped = new WeakSet()
  const wrapSend = createWrapSend(mainSendCh)

  Object.defineProperty(OriginalBrowserWindow.prototype, 'webContents', {
    get () {
      const webContents = descriptor.get.apply(this)

      if (!wrapped.has(webContents)) {
        wrap(webContents, 'send', wrapSend)
        wrap(webContents, 'sendToFrame', () => wrapSendToFrame)

        wrapped.add(webContents)
      }

      return webContents
    },
  })
}

// eslint-disable-next-line n/no-missing-require
const electron = require('electron')

// Electron exports a string (the binary path) in plain Node, an object in Electron.
if (typeof electron !== 'string') {
  const { ipcMain, ipcRenderer, net } = electron

  if (net) {
    wrap(net, 'request', createWrapRequest(requestCh))
  }

  if (ipcRenderer) {
    wrap(ipcRenderer, 'invoke', createWrapSend(rendererSendCh, true))
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

    patchBrowserWindow(electron)
  }
}
