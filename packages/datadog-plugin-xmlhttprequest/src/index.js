'use strict'

function createWrapOpen (tracer) {
  return function wrapOpen (open) {
    return function openWithTrace (method, url) {
      this._datadog_method = method
      this._datadog_url = url

      return open.apply(this, arguments)
    }
  }
}

function createWrapSend (tracer, config) {
  return function wrapSend (send) {
    return function sendWithTrace (body) {
      const span = tracer.startSpan('http.request')

      inject(this, tracer, span)

      this.addEventListener('error', e => span.setTag('error', e))
      this.addEventListener('loadend', () => {
        const method = this._datadog_method
        const url = this.responseURL || this._datadog_url

        span.addTags({
          'span.kind': 'client',
          'service.name': getServiceName(tracer, config, url),
          'resource.name': method,
          'span.type': 'http',
          'http.method': method,
          'http.url': url
        })

        span.finish()
      })

      return send.apply(this, arguments)
    }
  }
}

function getServiceName (tracer, config, url) {
  if (config.splitByDomain) {
    return (new URL(url)).host
  } else if (config.service) {
    return config.service
  }

  return tracer._service
}

function inject (xhr, tracer, span) {
  const format = window.datadog.ext.formats.HTTP_HEADERS
  const headers = {}

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
