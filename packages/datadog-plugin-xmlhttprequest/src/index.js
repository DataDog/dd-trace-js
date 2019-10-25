'use strict'

function createWrapOpen (tracer) {
  return function wrapOpen (open) {
    return function openWithTrace (method, url) {
      this._datadog_method = method
      this._datadog_url = new URL(url, window.location.origin)

      return open.apply(this, arguments)
    }
  }
}

function createWrapSend (tracer, config) {
  return function wrapSend (send) {
    return function sendWithTrace (body) {
      const service = config.service || `${tracer._service}-http-client`
      const method = this._datadog_method
      const url = this._datadog_url.href
      const span = tracer.startSpan('http.request')

      inject(this, tracer, span)

      this.addEventListener('error', e => span.setTag('error', e))
      this.addEventListener('load', () => span.setTag('http.status', this.status))
      this.addEventListener('loadend', () => {
        span.addTags({
          'span.kind': 'client',
          'service.name': service,
          'resource.name': method,
          'span.type': 'http',
          'http.method': method,
          'http.url': url
        })

        span.finish()
      })

      return tracer.scope().bind(send, span).apply(this, arguments)
    }
  }
}

function inject (xhr, tracer, span) {
  const format = window.ddtrace.ext.formats.HTTP_HEADERS
  const headers = {}
  const origin = xhr._datadog_url.origin
  const peers = tracer._peers

  if (origin !== window.location.origin && peers.indexOf(origin) === -1) return

  tracer.inject(span, format, headers)

  for (const name in headers) {
    xhr.setRequestHeader(name, headers[name])
  }
}

module.exports = {
  name: 'XMLHttpRequest',
  patch (XMLHttpRequest, tracer, config) {
    this.wrap(XMLHttpRequest.prototype, 'open', createWrapOpen(tracer, config))
    this.wrap(XMLHttpRequest.prototype, 'send', createWrapSend(tracer, config))
  },

  unpatch (XMLHttpRequest) {
    this.unwrap(XMLHttpRequest.prototype, 'open')
    this.unwrap(XMLHttpRequest.prototype, 'send')
  }
}
