'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { storage } = require('../../datadog-core')
const { isTrue } = require('../../dd-trace/src/util')
const coalesce = require('koalas')
const { tagsFromRequest, tagsFromResponse } = require('../../dd-trace/src/payload-tagging')

class BaseAwsSdkPlugin extends ClientPlugin {
  static get id () { return 'aws' }
  static get isPayloadReporter () { return false }

  get serviceIdentifier () {
    const id = this.constructor.id.toLowerCase()
    Object.defineProperty(this, 'serviceIdentifier', {
      configurable: true,
      writable: true,
      enumerable: true,
      value: id
    })
    return id
  }

  get cloudTaggingConfig () {
    return this._tracerConfig.cloudPayloadTagging
  }

  get payloadTaggingRules () {
    return this.cloudTaggingConfig.rules.aws?.[this.constructor.id]
  }

  constructor (...args) {
    super(...args)

    this.addBind(`apm:aws:request:start:${this.serviceIdentifier}`, (ctx) => {
      const {
        request,
        operation,
        awsRegion,
        awsService
      } = ctx

      const childOf = this.tracer.scope().active()

      if (!this.isEnabled(request)) {
        return childOf
      }

      const meta = {
        'span.kind': 'client',
        'service.name': this.serviceName(),
        'aws.operation': operation,
        'aws.region': awsRegion,
        region: awsRegion,
        aws_service: awsService,
        'aws.service': awsService,
        component: 'aws-sdk'
      }
      if (this.requestTags) this.requestTags.set(request, meta)

      const span = this.startSpan(this.operationFromRequest(request), { childOf, meta }, ctx)

      analyticsSampler.sample(span, this.config.measured)

      storage('legacy').run(ctx.currentStore, () => {
        this.requestInject(span, request)
      })

      if (this.constructor.isPayloadReporter && this.cloudTaggingConfig.requestsEnabled) {
        const maxDepth = this.cloudTaggingConfig.maxDepth
        const requestTags = tagsFromRequest(this.payloadTaggingRules, request.params, { maxDepth })
        span.addTags(requestTags)
      }

      return ctx.currentStore
    })

    this.addSub(`apm:aws:request:region:${this.serviceIdentifier}`, ({ region }) => {
      const store = storage('legacy').getStore()
      if (!store) return
      const { span } = store
      if (!span) return
      span.setTag('aws.region', region)
      span.setTag('region', region)
    })

    this.addBind(`apm:aws:request:complete:${this.serviceIdentifier}`, ctx => ctx.parentStore)

    this.addSub(`apm:aws:request:complete:${this.serviceIdentifier}`, ctx => {
      const { response, cbExists = false, currentStore } = ctx
      if (!currentStore) return
      const { span } = currentStore
      if (!span) return

      storage('legacy').run(currentStore, () => {
        // try to extract DSM context from response if no callback exists as extraction normally happens in CB
        if (!cbExists && this.serviceIdentifier === 'sqs') {
          const params = response.request.params
          const operation = response.request.operation
          this.responseExtractDSMContext(operation, params, response.data ?? response, span)
        }
        this.addResponseTags(span, response)

        if (this._tracerConfig?.trace?.aws?.addSpanPointers) {
          this.addSpanPointers(span, response)
        }
      })

      this.finish(ctx)
    })
  }

  requestInject (span, request) {
    // implemented by subclasses, or not
  }

  addSpanPointers (span, response) {
    // Optionally implemented by subclasses, for services where we're unable to inject trace context
  }

  operationFromRequest (request) {
    // can be overriden by subclasses
    return this.operationName({
      id: 'aws',
      type: 'web',
      kind: 'client',
      awsService: this.serviceIdentifier
    })
  }

  serviceName () {
    return this.config.service ||
      super.serviceName({
        id: 'aws',
        type: 'web',
        kind: 'client',
        awsService: this.serviceIdentifier
      })
  }

  isEnabled (request) {
    const serviceId = this.serviceIdentifier.toUpperCase()
    const envVarValue = process.env[`DD_TRACE_AWS_SDK_${serviceId}_ENABLED`]
    return envVarValue ? isTrue(envVarValue) : true
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

    if (this.constructor.isPayloadReporter && this.cloudTaggingConfig.responsesEnabled) {
      const maxDepth = this.cloudTaggingConfig.maxDepth
      const responseBody = this.extractResponseBody(response)
      const responseTags = tagsFromResponse(this.payloadTaggingRules, responseBody, { maxDepth })
      span.addTags(responseTags)
    }
  }

  extractResponseBody (response) {
    if (response.hasOwnProperty('data')) {
      return response.data
    }
    return Object.fromEntries(
      Object.entries(response).filter(([key]) => !['request', 'requestId', 'error', '$metadata'].includes(key))
    )
  }

  generateTags () {
    // implemented by subclasses, or not
  }

  finish (ctx) {
    const { currentStore, response } = ctx
    const { span } = currentStore
    const error = response?.error || ctx.error

    if (error) {
      span.setTag('error', error)

      const requestId = error.RequestId || error.requestId
      if (requestId) {
        span.addTags({ 'aws.response.request_id': requestId })
      }
    }

    if (response) {
      this.config.hooks.request(span, response)
    }

    super.finish(ctx)
  }

  configure (config) {
    super.configure(normalizeConfig(config, this.serviceIdentifier))
  }
}

function normalizeConfig (config, serviceIdentifier) {
  const hooks = getHooks(config)

  let specificConfig = config[serviceIdentifier]
  switch (typeof specificConfig) {
    case 'undefined':
      specificConfig = {}
      break
    case 'boolean':
      specificConfig = { enabled: specificConfig }
      break
  }

  // check if AWS batch propagation or AWS_[SERVICE] batch propagation is enabled via env variable
  const serviceId = serviceIdentifier.toUpperCase()
  const batchPropagationEnabled = isTrue(
    coalesce(
      specificConfig.batchPropagationEnabled,
      process.env[`DD_TRACE_AWS_SDK_${serviceId}_BATCH_PROPAGATION_ENABLED`],
      config.batchPropagationEnabled,
      process.env.DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED,
      false
    )
  )

  // Merge the specific config back into the main config
  return Object.assign({}, config, specificConfig, {
    splitByAwsService: config.splitByAwsService !== false,
    batchPropagationEnabled,
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = BaseAwsSdkPlugin
