'use strict'

const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { getSharedChannel } = require('../shared-channels')

const httpNames = ['http', 'node:http']
const httpsNames = ['https', 'node:https']

// Generic HTTP server instrumentation - no product-specific logic

const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')
const startSetHeaderCh = channel('datadog:http:server:response:set-header:start')

// Generic channel for request interception - use shared channel to ensure same instance
const requestInterceptCh = getSharedChannel('apm:http:server:request:intercept')

const requestFinishedSet = new WeakSet()

addHook({ name: httpNames }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmitForInterception)
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

addHook({ name: httpsNames }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmitForInterception)
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

// Generic request interceptor - allows any plugin to intercept requests
function wrapEmitForInterception (emit) {
  return function (eventName, req, res) {
    // Only process 'request' events
    if (eventName !== 'request') {
      return emit.apply(this, arguments)
    }

    // Check if any plugin wants to intercept this request
    if (!requestInterceptCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    const interceptData = {
      req,
      res,
      emit,
      server: this,
      originalArgs: arguments,
      handled: false // Plugin sets this to true if it handles the request
    }

    // Publish to generic intercept channel - any plugin can subscribe
    requestInterceptCh.publish(interceptData)

    // If a plugin handled it, don't continue with normal processing
    return interceptData.handled ? true : emit.apply(this, arguments)
  }
}

function wrapEmit (emit) {
  return function (eventName, req, res) {
    if (!startServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (eventName === 'request') {
      res.req = req
      if (req._isPubSubPush || req._isCloudEvent) {
        return emit.apply(this, arguments)
      }

      // Normal HTTP request processing (not PubSub/Cloud Events)
      const abortController = new AbortController()
      startServerCh.publish({ req, res, abortController })

      try {
        if (abortController.signal.aborted) {
          // TODO: should this always return true ?
          return this.listenerCount(eventName) > 0
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

function wrapSetHeader (setHeader) {
  return function wrappedSetHeader (name, value) {
    if (!startSetHeaderCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers) {
      return setHeader.apply(this, arguments)
    }

    if (startSetHeaderCh.hasSubscribers) {
      const abortController = new AbortController()
      startSetHeaderCh.publish({ res: this, abortController })

      if (abortController.signal.aborted) {
        return
      }
    }

    const setHeaderResult = setHeader.apply(this, arguments)

    if (finishSetHeaderCh.hasSubscribers) {
      finishSetHeaderCh.publish({ name, value, res: this })
    }

    return setHeaderResult
  }
}

function wrapAppendOrRemoveHeader (originalMethod) {
  return function wrappedAppendOrRemoveHeader () {
    if (!startSetHeaderCh.hasSubscribers) {
      return originalMethod.apply(this, arguments)
    }

    const abortController = new AbortController()
    startSetHeaderCh.publish({ res: this, abortController })

    if (abortController.signal.aborted) {
      return this
    }

    return originalMethod.apply(this, arguments)
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

// Export the channel for plugins to use the same instance
module.exports = { requestInterceptCh }
