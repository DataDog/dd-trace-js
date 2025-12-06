'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, tracingChannel } = require('./helpers/instrument')

const requestCh = tracingChannel('apm:electron:net:request')
const mainEmitCh = channel('apm:electron:ipc:main:emit')
const mainReceiveCh = tracingChannel('apm:electron:ipc:main:receive')
const mainHandleCh = tracingChannel('apm:electron:ipc:main:handle')
const mainSendCh = tracingChannel('apm:electron:ipc:main:send')
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

function wrapEmit (emit) {
  return function (channel, event, ...args) {
    mainEmitCh.publish({ channel, event, args })

    return emit.apply(this, arguments)
  }
}

function wrapSendToFrame (send) {
  return function (frameId, channel, ...args) {
    const ctx = { args, channel, frameId, self: this }

    return mainSendCh.traceSync(() => send.call(this, frameId, channel, ...args), ctx)
  }
}

function wrapWebContents (proto) {
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'webContents')
  const wrapped = new WeakSet()
  const wrapSend = createWrapSend(mainSendCh)

  Object.defineProperty(proto, 'webContents', {
    get () {
      const webContents = descriptor.get.apply(this)

      if (!wrapped.has(webContents)) {
        shimmer.wrap(webContents, 'postMessage', wrapSend)
        shimmer.wrap(webContents, 'send', wrapSend)
        shimmer.wrap(webContents, 'sendToFrame', wrapSendToFrame)

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
    shimmer.wrap(net, 'request', createWrapRequest(requestCh))
  }

  if (ipcMain) {
    shimmer.wrap(ipcMain, 'addListener', createWrapAddListener(mainReceiveCh, listeners))
    shimmer.wrap(ipcMain, 'emit', wrapEmit)
    shimmer.wrap(ipcMain, 'handle', createWrapAddListener(mainHandleCh, handlers))
    shimmer.wrap(ipcMain, 'handleOnce', createWrapAddListener(mainHandleCh, handlers))
    shimmer.wrap(ipcMain, 'off', createWrapRemoveListener(listeners))
    shimmer.wrap(ipcMain, 'on', createWrapAddListener(mainReceiveCh, listeners))
    shimmer.wrap(ipcMain, 'once', createWrapAddListener(mainReceiveCh, listeners))
    shimmer.wrap(ipcMain, 'removeAllListeners', createWrapRemoveAllListeners(listeners))
    shimmer.wrap(ipcMain, 'removeHandler', createWrapRemoveAllListeners(handlers))
    shimmer.wrap(ipcMain, 'removeListener', createWrapRemoveListener(listeners))
  }

  if (BrowserWindow) {
    wrapWebContents(BrowserWindow.prototype)
  }

  if (ipcRenderer) {
    shimmer.wrap(ipcRenderer, 'invoke', createWrapSend(rendererSendCh, true))
    shimmer.wrap(ipcRenderer, 'postMessage', createWrapSend(rendererSendCh))
    shimmer.wrap(ipcRenderer, 'send', createWrapSend(rendererSendCh))
    shimmer.wrap(ipcRenderer, 'sendSync', createWrapSend(rendererSendCh))

    shimmer.wrap(ipcRenderer, 'addListener', createWrapAddListener(rendererReceiveCh, listeners))
    shimmer.wrap(ipcRenderer, 'off', createWrapRemoveListener(listeners))
    shimmer.wrap(ipcRenderer, 'on', createWrapAddListener(rendererReceiveCh, listeners))
    shimmer.wrap(ipcRenderer, 'once', createWrapAddListener(rendererReceiveCh, listeners))
    shimmer.wrap(ipcRenderer, 'removeListener', createWrapRemoveListener(listeners))
    shimmer.wrap(ipcRenderer, 'removeAllListeners', createWrapRemoveAllListeners(listeners))
  }

  return electron
})
