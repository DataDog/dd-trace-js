'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapRequest (tracer, config) {
  config = normalizeConfig(config)
  return function wrapRequest (request) {

    // (operation, params, callback)
    return function requestWithTrace (operation, params, cb) {
      // if (!params) return request.apply(this, arguments)


      // const tags = {
      //   [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
      //   [Tags.DB_TYPE]: 'elasticsearch',
      //   'service.name': config.service || `${tracer._service}-aws`,
      //   'resource.name': `${params.method} ${quantizePath(params.path)}`,
      //   'span.type': 'elasticsearch',
      //   'elasticsearch.url': params.path,
      //   'elasticsearch.method': params.method,
      //   'elasticsearch.params': JSON.stringify(params.querystring || params.query)
      // }

      // look how ruby/java are defining these details
      let tags = {
        'service.name': config.service || `${tracer._service}-aws`,
        'resource.name': 'request',
        'span.type': 'http'
      }

      const childOf = tracer.scope().active()
      const span = tracer.startSpan('aws.request', {
        childOf,
        tags: tags
      })

      // if (params.body) {
      //   span.setTag('elasticsearch.body', JSON.stringify(params.body))
      // }

      analyticsSampler.sample(span, config.analytics)

      // cb = request.length === 2 || typeof options === 'function'
      //   ? tracer.scope().bind(options, childOf)
      //   : tracer.scope().bind(cb, childOf)

      // if typeof cb === 'function'
      tracer.scope().bind(cb, childOf)

      return tracer.scope().activate(span, () => {
      //   if (typeof cb === 'function') {
      //     if (request.length === 2) {
      //       return request.call(this, params, wrapCallback(tracer, span, params, config, cb))
      //     } else {
        console.log('ok and in here')
        console.log('params', operation)
        // console.log('options', params)
        // console.log('cb', this)
        return request.call(this, operation, params, wrapCallback(tracer, span, cb))
        //   }
        // } else {
        //   const promise = request.apply(this, arguments)

        //   if (promise && typeof promise.then === 'function') {
        //     promise.then(() => finish(span, params, config), e => finish(span, params, config, e))
        //   } else {
        //     finish(span, params, config)
        //   }

        //   return promise
        // }
      // })
      })
    }
  }
}

function wrapCallback (tracer, span, done) {
  return function (err) {
    finish(span, err)

    console.log('invoked?')
    if (typeof done === 'function') {
      done.apply(null, arguments)
    } else {
      console.log('uh oh')
    }
    
  }
}

function finish (span, err) {
  if (err) {
    span.addTags({
      'error.type': err.name,
      'error.msg': err.message,
      'error.stack': err.stack
    })
  }

  span.finish()
}

// function quantizePath (path) {
//   return path && path.replace(/[0-9]+/g, '?')
// }

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const query = (config.hooks && config.hooks.query) || noop

  return { query }
}

module.exports = [
  {
    name: 'aws-sdk',
    versions: ['>=2'],
    patch (AWS, tracer, config) {

      // console.log('trying to patch', AWS.Service, AWS.Service.prototype)



      this.wrap(AWS.Service.prototype, 'makeRequest', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      this.unwrap(AWS.Service.prototype, 'makeRequest')
    }
  }
]
