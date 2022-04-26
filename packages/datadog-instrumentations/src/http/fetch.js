'use strict'

const shimmer = require('../../../datadog-shimmer')

const {
  channel,
  AsyncResource
} = require('../helpers/instrument')

const startClientCh = channel('apm:fetch:start')
const asyncEndClientCh = channel('apm:fetch:async-end')
const endClientCh = channel('apm:fetch:end')
const errorClientCh = channel('apm:fetch:error')

shimmer.wrap(global, 'fetch', instrumentFetch)

function instrumentFetch (fetch) {
  return async function wrappedFetch (resource, init) {
    if (!startClientCh.hasSubscribers) {
      return fetch.apply(this, arguments)
    }

    if (!(resource instanceof Request && !init)) {
      resource = new Request(resource, init)
    }

    startClientCh.publish({ req: resource })

    let response
    AsyncResource.bind(() => {
      response = fetch.call(this, resource, init)
      response.catch(e => {
        errorClientCh.publish(e)
        throw e
      })
      endClientCh.publish({ response })
    })()
    return response
  }
}

shimmer.wrap(global.ReadableStream.prototype, 'getReader', getReader => function wrappedGetReader() {
  const reader = getReader.apply(this, arguments)
  if (asyncEndClientCh.hasSubscribers) {
    reader.closed.then(() => {
      asyncEndClientCh.publish()
    })
  }
  return reader
})

shimmer.wrap(global.Response.prototype, 'arrayBuffer', createBodyHelperWrapper('arrayBuffer'))
shimmer.wrap(global.Response.prototype, 'blob', createBodyHelperWrapper('blob'))
shimmer.wrap(global.Response.prototype, 'formData', createBodyHelperWrapper('formData'))
shimmer.wrap(global.Response.prototype, 'json', createBodyHelperWrapper('json'))
shimmer.wrap(global.Response.prototype, 'text', createBodyHelperWrapper('text'))

function createBodyHelperWrapper(name) {
  return method => {
    const fn = function () {
      const p = method.apply(this, arguments)
      if (!asyncEndClientCh.hasSubscribers && this.bodyUsed) return p
      return p.then(result => {
        asyncEndClientCh.publish()
        return result
      }, e => {
        errorClientCh.publish(e)
        throw e
      })
    }
    Object.defineProperty(fn, 'name',
      Object.assign(
        Object.getOwnPropertyDescriptor(fn, 'name'),
        { value: name }
      )
    )
    return fn
  }
}
