'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const { getHTMLComment } = require('../../dd-trace/src/plugins/util/injection')

function createWrapEmit (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapEmit (emit) {
    return function emitWithTrace (eventName, req, res) {
      if (eventName === 'request') {
        return web.instrument(tracer, config, req, res, 'http.request', () => {
          return emit.apply(this, arguments)
        })
      }

      return emit.apply(this, arguments)
    }
  }
}

function parseHeader (value) {
  const values = {}
  if (value === undefined) {
    return values
  }
  value.split(',')
    .forEach((s) => {
      const [k, v] = s.trim().split('=')
      values[k] = v || true
    })
  return values
}

function shouldTraceRes (tracer, res) {
  const active = tracer.scope().active()
  if (!active) {
    return false
  }
  const span = active.context()
  if (span._manualHTMLInjection) {
    return false
  }
  if (span._sampling.priority === -1 && !span._traceFlags.sampled) {
    return false
  }
  const contentType = res.getHeader('content-type')
  if (!contentType || !contentType.includes('text/html')) {
    return false
  }
  const contentEncoding = res.getHeader('content-encoding')
  if (contentEncoding !== undefined && contentEncoding !== 'identity') {
    return false
  }
  const transferEncoding = res.getHeader('transfer-encoding')
  if (transferEncoding !== undefined && transferEncoding !== 'identity') {
    return false
  }
  const surrogateControl = parseHeader(res.getHeader('surrogate-control'))
  if (surrogateControl['max-age'] && surrogateControl['max-age'] !== '0') {
    return false
  }
  const cacheControl = parseHeader(res.getHeader('cache-control'))
  if (cacheControl['max-age'] && cacheControl['max-age'] !== '0') {
    return false
  }
  if (cacheControl['s-maxage'] && cacheControl['s-maxage'] !== '0') {
    return false
  }
  const expires = res.getHeader('expires')
  if (expires !== undefined && (expires !== '0' || Date(expires).getTime() > Date.now())) {
    return false
  }
  return true
}

function handleWriteOrEnd (tracer, res, args) {
  if (!res._headerSent && shouldTraceRes(tracer, res)) {
    if (args.length > 0) {
      if (!res._ddHTMLComment) {
        res._ddHTMLComment = getHTMLComment(tracer)
      }
      args[0] = res._ddHTMLComment + args[0]
    }
  }
}

function createWrapWrite (tracer) {
  return function wrapWrite (write) {
    return function writeWithTrace (chunk, encoding, callback) {
      handleWriteOrEnd(tracer, this, arguments)
      return write.apply(this, arguments)
    }
  }
}

function createWrapEnd (tracer) {
  return function wrapEnd (end) {
    return function endWithTracer (chunk, encoding, callback) {
      handleWriteOrEnd(tracer, this, arguments)
      return end.apply(this, arguments)
    }
  }
}

function createWrapWriteHead (tracer) {
  return function wrapWriteHead (writeHead) {
    return function implicitHeaderWithTrace () {
      let headersIndex = -1
      if (typeof arguments[1] === 'string') {
        headersIndex = 2
      } else {
        headersIndex = 1
      }
      if (arguments[headersIndex]) {
        const headers = arguments[headersIndex]
        Object.keys(headers).forEach((key) => {
          this.setHeader(key, headers[key])
        })
        arguments[headersIndex] = undefined
      }
      if (shouldTraceRes(tracer, this)) {
        if (this._contentLength !== null) {
          if (!this._ddHTMLComment) {
            this._ddHTMLComment = getHTMLComment(tracer)
            this._contentLength += Buffer.byteLength(this._ddHTMLComment)
          }
        }
      }
      return writeHead.apply(this, arguments)
    }
  }
}

function plugin (name) {
  return {
    name,
    patch (http, tracer, config) {
      if (config.server === false) return

      this.wrap(http.Server.prototype, 'emit', createWrapEmit(tracer, config))

      this.wrap(http.ServerResponse.prototype, 'write', createWrapWrite(tracer))
      this.wrap(http.ServerResponse.prototype, 'end', createWrapEnd(tracer))
      this.wrap(http.ServerResponse.prototype, 'writeHead', createWrapWriteHead(tracer))
    },
    unpatch (http) {
      this.unwrap(http.Server.prototype, 'emit')
    }
  }
}

module.exports = [
  plugin('http'),
  plugin('https')
]
