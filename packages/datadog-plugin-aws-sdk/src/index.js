'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapRequest (tracer, config) {
  config = normalizeConfig(config)

  return function wrapRequest (request) {
    return function requestWithTrace (operation, params, cb) {
      // if (!params) return request.apply(this, arguments)
      // ^do the same if tracer not enabled

      const serviceName = this.api && this.api.abbreviation
      // look how ruby/java are defining these details
      let tags = {
        'service.name': config.service || `${tracer._service}-aws`,
        'resource.name': `${serviceName}_${operation}`,
        'span.kind': 'client',
        'span.type': 'http',
        'aws.agent': 'js-aws-sdk',
        'aws.operation': operation,
        'aws.region': request.httpRequest && request.httpRequest.region || this.config.region,
        'aws.service': serviceName,
        'component': serviceName
      }

      const childOf = tracer.scope().active()
      const span = tracer.startSpan('aws.http', {
        childOf,
        tags: tags
      })

      analyticsSampler.sample(span, config.analytics)

      if (typeof cb === 'function') {
        return tracer.scope().activate(span, () => {
          return request.call(this, operation, params, wrapCallback(tracer, span, cb, childOf))
         }) 
      } else {
        
        const awsRequest = request.apply(this, arguments)

        awsRequest.on('send', function(response) {
          tracer.scope().activate(span)
        })

        awsRequest.on('complete', function(response) {
          if(response.requestId) {
            span.addTags('aws.requestId')
          }
          
          if (response.error) {
            
          } else {
            // we can use response.data here
          }
          finish(span, response.error)
        })

        return awsRequest
      }      
    }
  }
}

function wrapCallback (tracer, span, done, parent) {
  return function (err) {
    finish(span, err)

    if (typeof done === 'function') {
      tracer.scope().activate(parent, () => {
        done.apply(null, arguments)
      })
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
    versions: ['>=2.0'],
    patch (AWS, tracer, config) {

      // console.log('trying to patch', AWS.Service, AWS.Service.prototype)

      this.wrap(AWS.Service.prototype, 'makeRequest', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      this.unwrap(AWS.Service.prototype, 'makeRequest')
    }
  }
]
