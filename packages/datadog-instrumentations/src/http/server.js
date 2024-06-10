'use strict'

const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')

const requestFinishedSet = new WeakSet()

const httpNames = ['http', 'node:http']
const httpsNames = ['https', 'node:https']

addHook({ name: httpNames }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  shimmer.wrap(http.ServerResponse.prototype, 'writeHead', wrapWriteHead)
  shimmer.wrap(http.ServerResponse.prototype, 'write', wrapWrite)
  shimmer.wrap(http.ServerResponse.prototype, 'end', wrapEnd)
  return http
})

addHook({ name: httpsNames }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

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

function wrapWriteHead (writeHead) {
  return function wrappedWriteHead (statusCode, reason, obj) {
    if (!startWriteHeadCh.hasSubscribers) {
      return writeHead.apply(this, arguments)
    }

    const abortController = new AbortController()

    if (typeof reason !== 'string') {
      obj ??= reason
    }

    // support writeHead(200, ['key1', 'val1', 'key2', 'val2'])
    if (Array.isArray(obj)) {
      const headers = {}

      for (let i = 0; i < obj.length; i += 2) {
        headers[obj[i]] = obj[i + 1]
      }

      obj = headers
    }

    // this doesn't support explicit duplicate headers, but it's an edge case
    const responseHeaders = Object.assign(this.getHeaders(), obj)

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode,
      responseHeaders
    })

    if (abortController.signal.aborted) {
      return this
    }

    return writeHead.apply(this, arguments)
  }
}

function wrapWrite (write) {
  return function wrappedWrite () {
    if (!startWriteHeadCh.hasSubscribers) {
      return write.apply(this, arguments)
    }

    const abortController = new AbortController()

    const responseHeaders = this.getHeaders()

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders
    })

    if (abortController.signal.aborted) {
      return true
    }

    return write.apply(this, arguments)
  }
}

function wrapEnd (end) {
  return function wrappedEnd () {
    if (!startWriteHeadCh.hasSubscribers) {
      return end.apply(this, arguments)
    }

    const abortController = new AbortController()

    const responseHeaders = this.getHeaders()

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders
    })

    if (abortController.signal.aborted) {
      return this
    }

    return end.apply(this, arguments)
  }
}
