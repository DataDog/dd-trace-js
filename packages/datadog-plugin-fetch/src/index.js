'use strict'

const tx = require('../../dd-trace/src/plugins/util/tx')

function createWrapFetch (tracer, config) {
  return function wrapFetch (fetch) {
    const fetchWithTrace = function fetchWithTrace () {
      return fetch._datadog_wrapper.apply(this, arguments)
    }

    fetch._datadog_wrapper = function (resource, init) {
      const method = getMethod(resource, init)
      const url = getUrl(resource)
      const span = tracer.startSpan('http.request', {
        'span.kind': 'client',
        'service.name': 'browser',
        'resource.name': method,
        'span.type': 'http',
        'http.method': method,
        'http.url': url.href
      })

      init = inject(init, tracer, span, url.origin)

      const promise = tracer.scope().bind(fetch, span).call(this, resource, init)

      promise.then(res => {
        span.setTag('http.status_code', res.status)
      })

      tx.wrap(span, promise)

      return promise
    }

    return fetchWithTrace
  }
}

function unwrapFetch (fetch) {
  fetch._datadog_wrapper = fetch
}

function getMethod (resource, init) {
  if (init && init.method) return init.method
  if (resource && resource.method) return resource.method

  return 'GET'
}

function getUrl (resource) {
  const url = typeof resource === 'object'
    ? resource.url
    : resource

  return new URL(url, window.location.origin)
}

function inject (init, tracer, span, origin) {
  const format = window.ddtrace.ext.formats.HTTP_HEADERS
  const peers = tracer._peers

  if (origin !== window.location.origin && peers.indexOf(origin) === -1) return

  init = init || {}
  init.headers = init.headers || {}

  if (typeof init.headers.set === 'function') {
    const headers = {}

    tracer.inject(span, format, headers)

    for (const name in headers) {
      init.headers.set(name, headers[name])
    }
  } else {
    tracer.inject(span, format, init.headers)
  }

  return init
}

module.exports = {
  name: 'fetch',
  patch (fetch, tracer, config) {
    return createWrapFetch(tracer, config)(fetch)
  },

  unpatch (fetch) {
    unwrapFetch(fetch)
  }
}
