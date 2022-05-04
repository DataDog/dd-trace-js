'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

class BaseAwsSdkPlugin extends Plugin {
  static get serviceIdentifier () {
    const id = this.name.toLowerCase()
    Object.defineProperty(this, 'serviceIdentifier', {
      configurable: true,
      writable: true,
      enumerable: true,
      value: id
    })
    return id
  }

  get serviceIdentifier () {
    const id = this.constructor.serviceIdentifier
    Object.defineProperty(this, 'serviceIdentifier', {
      configurable: true,
      writable: true,
      enumerable: true,
      value: id
    })
    return id
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:aws:request:start:${this.serviceIdentifier}`, ({
      request,
      operation,
      awsRegion,
      awsService,
      serviceIdentifier
    }) => {
      if (!this.isEnabled(request)) {
        return
      }
      const serviceName = this.getServiceName(serviceIdentifier)
      const childOf = this.tracer.scope().active()
      const tags = {
        [Tags.SPAN_KIND]: 'client',
        'service.name': serviceName,
        'aws.operation': operation,
        'aws.region': awsRegion,
        'aws.service': awsService,
        'component': 'aws-sdk'
      }
      if (this.requestTags) this.requestTags.set(request, tags)

      const span = this.tracer.startSpan('aws.request', { childOf, tags })

      analyticsSampler.sample(span, this.config.measured)

      this.requestInject(span, request)

      const store = storage.getStore()

      this.enter(span, store)
    })

    this.addSub(`apm:aws:request:complete:${this.serviceIdentifier}`, ({ response }) => {
      const store = storage.getStore()
      if (!store) return
      const { span } = store
      if (!span) return
      this.addResponseTags(span, response)
      this.finish(span, response, response.error)
    })
  }

  requestInject (/* sapn, request */) {
    // implemented by subclasses, or not
  }

  isEnabled (/* request */) {
    if (typeof this.config === 'boolean') return this.config
    if (typeof this.config === 'object' && typeof this.config[this.serviceIdentifier] === 'boolean') {
      return this.config[this.serviceIdentifier]
    }

    return true
  }

  addResponseTags (span, response) {
    if (!span || !response.request) return
    const params = response.request.params
    const operation = response.request.operation
    const extraTags = this.generateTags(params, operation, response) || {}
    const tags = Object.assign({
      'aws.response.request_id': response.requestId,
      'resource.name': operation,
      'span.kind': 'client'
    }, extraTags)

    span.addTags(tags)
  }

  generateTags () {
    // implemented by subclasses, or not
  }

  finish (span, response, err) {
    if (err) {
      span.setTag('error', err)

      if (err.requestId) {
        span.addTags({ 'aws.response.request_id': err.requestId })
      }
    }

    if (response) {
      this.config.hooks.request(span, response)
    }

    span.finish()
  }

  configure (config) {
    super.configure(normalizeConfig(config))
  }

  // TODO: test splitByAwsService when the test suite is fixed
  getServiceName (serviceIdentifier) {
    return this.config.service
      ? this.config.service
      : `${this.tracer._service}-aws-${serviceIdentifier}`
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    splitByAwsService: config.splitByAwsService !== false,
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = BaseAwsSdkPlugin
