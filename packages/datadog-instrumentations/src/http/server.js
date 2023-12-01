'use strict'

const { AbortController } = require('node-abort-controller') // AbortController is not available in node <15
const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')
const endResponseCh = channel('apm:http:server:response:end:start') // TODO: fix the name
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')

const requestEndedSet = new WeakSet()
const requestFinishedSet = new WeakSet()

addHook({ name: 'https' }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

addHook({ name: 'http' }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.ServerResponse.prototype, 'end', wrapWriteHead)
  shimmer.wrap(http.ServerResponse.prototype, 'writeHead', wrapWriteHead)
  shimmer.wrap(http.ServerResponse.prototype, 'write', wrapWriteHead)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

function wrapWriteHead (writeHead) {
  return function (statusCode) {
    if (this.finished) return

    if (requestEndedSet.has(this)) {
      return writeHead.apply(this, arguments)
    }

    requestEndedSet.add(this)

    const abortController = new AbortController()

    // TODO: this doesn't support headers sent with res.writeHead()
    const responseHeaders = this.getHeaders()

    endResponseCh.publish({ req: this.req, res: this, abortController, statusCode, responseHeaders })

    if (abortController.signal.aborted) {
      return
    }

    return writeHead.apply(this, arguments)
  }
}

function wrapResponseEmit (emit) {
  return function (eventName, event) {
    if (!finishServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (['finish', 'close'].includes(eventName) && !requestFinishedSet.has(this)) {
      finishServerCh.publish({ req: this.req })
      requestFinishedSet.add(this)
    }

    return emit.apply(this, arguments)
  }
}
function wrapEmit (emit) {
  return function (eventName, req, res) {
    if (!startServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (eventName === 'request') {
      res.req = req

      const abortController = new AbortController()

      startServerCh.publish({ req, res, abortController })

      try {
        if (abortController.signal.aborted) {
          // TODO: should this always return true ?
          return this.listenerCount(eventName) > 0
        }
        if (finishSetHeaderCh.hasSubscribers) {
          wrapSetHeader(res)
        }
        return emit.apply(this, arguments)
      } catch (err) {
        errorServerCh.publish(err)

        throw err
      } finally {
        exitServerCh.publish({ req })
      }
    }
    return emit.apply(this, arguments)
  }
}

function wrapSetHeader (res) {
  shimmer.wrap(res, 'setHeader', setHeader => {
    return function (name, value) {
      const setHeaderResult = setHeader.apply(this, arguments)
      finishSetHeaderCh.publish({ name, value, res })
      return setHeaderResult
    }
  })
}
