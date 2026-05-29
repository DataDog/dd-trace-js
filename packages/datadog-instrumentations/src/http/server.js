'use strict'

const {
  channel,
  addHook,
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')
const startSetHeaderCh = channel('datadog:http:server:response:set-header:start')

const requestFinishedSet = new WeakSet()

addHook({ name: 'http' }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  shimmer.wrap(http.ServerResponse.prototype, 'writeHead', wrapWriteHead)
  shimmer.wrap(http.ServerResponse.prototype, 'write', wrapWrite)
  shimmer.wrap(http.ServerResponse.prototype, 'end', wrapEnd)
  shimmer.wrap(http.ServerResponse.prototype, 'setHeader', wrapSetHeader)
  shimmer.wrap(http.ServerResponse.prototype, 'removeHeader', wrapAppendOrRemoveHeader)
  // Added in node v16.17.0
  if (http.ServerResponse.prototype.appendHeader) {
    shimmer.wrap(http.ServerResponse.prototype, 'appendHeader', wrapAppendOrRemoveHeader)
  }
  return http
})

addHook({ name: 'https' }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

function wrapResponseEmit (emit) {
  // Rest params instead of named formals + `arguments`: a closure that both
  // names parameters and reads `arguments` makes V8 materialise the mapped
  // arguments object on every response event.
  return function (...args) {
    if (!finishServerCh.hasSubscribers) {
      return Reflect.apply(emit, this, args)
    }

    const eventName = args[0]
    if ((eventName === 'finish' || eventName === 'close') && !requestFinishedSet.has(this)) {
      finishServerCh.publish({ req: this.req })
      requestFinishedSet.add(this)
    }

    return Reflect.apply(emit, this, args)
  }
}

function wrapEmit (emit) {
  return function (...args) {
    if (!startServerCh.hasSubscribers) {
      return Reflect.apply(emit, this, args)
    }

    const eventName = args[0]
    if (eventName === 'request') {
      const req = args[1]
      const res = args[2]
      res.req = req

      const abortController = new AbortController()
      // Single ctx shared with `exitServerCh` below and forwarded by the
      // server plugin to `incomingHttpRequestStart`; existing subscribers
      // only read the message, so the reuse is safe.
      const ctx = { req, res, abortController }

      startServerCh.publish(ctx)

      try {
        if (abortController.signal.aborted) {
          // TODO: should this always return true ?
          return this.listenerCount(eventName) > 0
        }

        return Reflect.apply(emit, this, args)
      } catch (err) {
        errorServerCh.publish(err)

        throw err
      } finally {
        exitServerCh.publish(ctx)
      }
    }
    return Reflect.apply(emit, this, args)
  }
}

function wrapWriteHead (writeHead) {
  // Rest params + Reflect.apply instead of named formals + `arguments`: naming
  // params while reading `arguments` makes V8 materialise the mapped arguments
  // object on every call, including the no-subscriber fast path.
  return function wrappedWriteHead (...args) {
    if (!startWriteHeadCh.hasSubscribers) {
      return Reflect.apply(writeHead, this, args)
    }

    const statusCode = args[0]
    const reason = args[1]
    let obj = args[2]

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
    const responseHeaders = obj === undefined ? this.getHeaders() : Object.assign(this.getHeaders(), obj)

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode,
      responseHeaders,
    })

    if (abortController.signal.aborted) {
      return this
    }

    return Reflect.apply(writeHead, this, args)
  }
}

function wrapWrite (write) {
  return function wrappedWrite (...args) {
    if (!startWriteHeadCh.hasSubscribers) {
      return write.apply(this, args)
    }

    const abortController = new AbortController()

    const responseHeaders = this.getHeaders()

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders,
    })

    if (abortController.signal.aborted) {
      return true
    }

    return write.apply(this, args)
  }
}

function wrapSetHeader (setHeader) {
  return function wrappedSetHeader (...args) {
    if (!startSetHeaderCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers) {
      return Reflect.apply(setHeader, this, args)
    }

    if (startSetHeaderCh.hasSubscribers) {
      const abortController = new AbortController()
      startSetHeaderCh.publish({ res: this, abortController })

      if (abortController.signal.aborted) {
        return
      }
    }

    const setHeaderResult = Reflect.apply(setHeader, this, args)

    if (finishSetHeaderCh.hasSubscribers) {
      finishSetHeaderCh.publish({ name: args[0], value: args[1], res: this })
    }

    return setHeaderResult
  }
}

function wrapAppendOrRemoveHeader (originalMethod) {
  return function wrappedAppendOrRemoveHeader (...args) {
    if (!startSetHeaderCh.hasSubscribers) {
      return originalMethod.apply(this, args)
    }

    const abortController = new AbortController()
    startSetHeaderCh.publish({ res: this, abortController })

    if (abortController.signal.aborted) {
      return this
    }

    return originalMethod.apply(this, args)
  }
}

function wrapEnd (end) {
  return function wrappedEnd (...args) {
    if (!startWriteHeadCh.hasSubscribers) {
      return end.apply(this, args)
    }

    const abortController = new AbortController()

    const responseHeaders = this.getHeaders()

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders,
    })

    if (abortController.signal.aborted) {
      return this
    }

    return end.apply(this, args)
  }
}
