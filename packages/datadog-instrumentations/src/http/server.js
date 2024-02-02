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

const httpNames = ['http', 'node:http']
const httpsNames = ['https', 'node:https']

addHook({ name: httpNames }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  shimmer.wrap(http.ServerResponse.prototype, 'writeHead', wrapWriteHead)
  shimmer.wrap(http.ServerResponse.prototype, 'write', wrapWrite)
  return http
})

addHook({ name: httpsNames }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

function wrapWrite (write) {
  return function wrappedWrite () {
    if (this.finished || requestEndedSet.has(this)) {
      return this
    }

    return write.apply(this, arguments)
  }
}

function wrapEnd (end) {
  return function () {
    if (this.finished) return this

    if (requestEndedSet.has(this)) {
      return end.apply(this, arguments)
    }

    const abortController = new AbortController()

    // TODO: this doesn't support headers sent with res.writeHead()
    const responseHeaders = this.getHeaders()

    endResponseCh.publish({ req: this.req, res: this, abortController, statusCode: this.statusCode, responseHeaders })

    if (abortController.signal.aborted) {
      requestEndedSet.add(this)
      return
    }

    return end.apply(this, arguments)
  }
}

function wrapWriteHead (writeHead) {
  return function (statusCode) {
    if (this.finished) return this

    if (requestEndedSet.has(this)) {
      return writeHead.apply(this, arguments)
    }

    const abortController = new AbortController()

    // TODO: this doesn't support headers sent with res.writeHead()
    const responseHeaders = this.getHeaders()

    endResponseCh.publish({ req: this.req, res: this, abortController, statusCode, responseHeaders })

    if (abortController.signal.aborted) {
      requestEndedSet.add(this)
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
