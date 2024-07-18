'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { storage } = require('../../datadog-core')
const { isTrue, isFalse } = require('../../dd-trace/src/util')

class BaseAwsSdkPlugin extends ClientPlugin {
  static get id () { return 'aws' }

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

  constructor (...args) {
    super(...args)

    this.addSub(`apm:aws:request:start:${this.serviceIdentifier}`, ({
      request,
      operation,
      awsRegion,
      awsService
    }) => {
      if (!this.isEnabled(request)) {
        return
      }
      const childOf = this.tracer.scope().active()
      const tags = {
        'span.kind': 'client',
        'service.name': this.serviceName(),
        'aws.operation': operation,
        'aws.region': awsRegion,
        region: awsRegion,
        aws_service: awsService,
        'aws.service': awsService,
        component: 'aws-sdk'
      }
      if (this.requestTags) this.requestTags.set(request, tags)

      const span = this.tracer.startSpan(this.operationFromRequest(request), { childOf, tags })

      analyticsSampler.sample(span, this.config.measured)

      this.requestInject(span, request)

      const store = storage.getStore()

      this.enter(span, store)
    })

    this.addSub(`apm:aws:request:region:${this.serviceIdentifier}`, region => {
      const store = storage.getStore()
      if (!store) return
      const { span } = store
      if (!span) return
      span.setTag('aws.region', region)
      span.setTag('region', region)
    })

    this.addSub(`apm:aws:request:complete:${this.serviceIdentifier}`, ({ response, cbExists = false }) => {
      const store = storage.getStore()
      if (!store) return
      const { span } = store
      if (!span) return
      // try to extract DSM context from response if no callback exists as extraction normally happens in CB
      if (!cbExists && this.serviceIdentifier === 'sqs') {
        const params = response.request.params
        const operation = response.request.operation
        this.responseExtractDSMContext(operation, params, response.data ?? response, span)
      }
      this.addResponseTags(span, response)
      this.finish(span, response, response.error)
    })
  }

  requestInject (span, request) {
    // implemented by subclasses, or not
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
  }

  generateTags () {
    // implemented by subclasses, or not
  }

  finish (span, response, err) {
    if (err) {
      span.setTag('error', err)

      const requestId = err.RequestId || err.requestId
      if (requestId) {
        span.addTags({ 'aws.response.request_id': requestId })
      }
    }

    if (response) {
      this.config.hooks.request(span, response)
    }

    super.finish()
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

  const baseAWSBatchPropagationValue = process.env.DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED
  const baseAWSBatchPropagationEnabled = baseAWSBatchPropagationValue ? isTrue(baseAWSBatchPropagationValue) : false

  // check if AWS batch propagation or AWS_[SERVICE] batch propagation is enabled via env variable
  const serviceId = serviceIdentifier.toUpperCase()
  const serviceBatchPropagationValue = process.env[`DD_TRACE_AWS_SDK_${serviceId}_BATCH_PROPAGATION_ENABLED`]

  // we should respect the integration service configuration if set to false even if the base is set to true
  let serviceBatchPropagationEnabled
  if (isFalse(serviceBatchPropagationValue)) {
    serviceBatchPropagationEnabled = false
  } else {
    serviceBatchPropagationEnabled = serviceBatchPropagationValue
      ? isTrue(serviceBatchPropagationValue)
      : baseAWSBatchPropagationEnabled
  }

  // Merge the specific config back into the main config
  return {
    ...config,
    [serviceIdentifier]: {
      ...specificConfig,
      batchPropagationEnabled: serviceBatchPropagationEnabled
    },
    splitByAwsService: config.splitByAwsService !== false,
    batchPropagationEnabled: baseAWSBatchPropagationEnabled,
    hooks
  }
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = BaseAwsSdkPlugin
