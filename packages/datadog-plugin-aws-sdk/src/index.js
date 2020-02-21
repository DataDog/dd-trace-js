'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const awsHelpers = require('./helpers')

function createWrapRequest (tracer, config) {
  config = normalizeConfig(config)

  return function wrapRequest (request) {
    return function requestWithTrace (operation, params, cb) {
      const serviceName = this.serviceIdentifier
      const childOf = tracer.scope().active()
      const baseTags = {
        [Tags.SPAN_KIND]: 'client',
        'span.type': 'http',
        'service.name': config.service
          ? `${config.service}-aws-${serviceName}`
          : `${tracer._service}-aws-${serviceName}`,
        'aws.operation': operation,
        'aws.region': this.config.region,
        'aws.service': this.api.className,
        'aws.url': this.endpoint && this.endpoint.href,
        'component': 'aws-sdk'
      }
      let span

      if (typeof cb === 'function') {
        span = tracer.startSpan('aws.request', {
          childOf,
          tags: baseTags
        })

        analyticsSampler.sample(span, config.analytics)

        // when passed a callback makeRequest will call `.send` on the AWS.Request
        // before we have a chance to add our listeners, so we have to wrap
        // the callback in order know when the span has finished
        // https://github.com/aws/aws-sdk-js/blob/
        // 9c191bbdbf32a8a3fa31219e369006f852318a1f/lib/service.js#L202-L206
        return tracer.scope().activate(span, () => {
          return request.call(
            this,
            operation,
            params,
            awsHelpers.wrapCallback(tracer, span, cb, childOf, config, serviceName)
          )
        })
      } else {
        const awsReq = request.apply(this, arguments)
        const boundAwsReq = tracer.scope().bind(awsReq, childOf)

        // https://github.com/aws/aws-sdk-js/blob/38bf84c144281f696768e8c64500f2847fe6f298/lib/request.js#L142
        // https://github.com/aws/aws-sdk-js/blob/38bf84c144281f696768e8c64500f2847fe6f298/lib/request.js#L328-L332
        boundAwsReq.on('validate', () => {
          if (span) return

          span = tracer.startSpan('aws.request', {
            childOf,
            tags: baseTags
          })

          analyticsSampler.sample(span, config.analytics)
          tracer.scope().activate(span)
        })

        boundAwsReq.on('complete', response => {
          if (!span) return

          awsHelpers.addResponseTags(span, response, serviceName, config)
          awsHelpers.finish(span, response.error)
        })

        return boundAwsReq
      }
    }
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = [
  {
    name: 'aws-sdk',
    versions: ['>=2.6.5'],
    patch (AWS, tracer, config) {
      this.wrap(AWS.Service.prototype, 'makeRequest', createWrapRequest(tracer, config))
    },
    unpatch (AWS) {
      this.unwrap(AWS.Service.prototype, 'makeRequest')
    }
  }
]
