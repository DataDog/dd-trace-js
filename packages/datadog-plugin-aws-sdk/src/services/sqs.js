'use strict'

const Tags = require('opentracing').Tags
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')
const { storage } = require('../../../datadog-core')

class Sqs extends BaseAwsSdkPlugin {
  constructor (...args) {
    super(...args)

    this.requestTags = new WeakMap()

    this.addSub('apm:aws:response:start:sqs', obj => {
      const { request, response } = obj
      const store = storage.getStore()
      const plugin = this
      const maybeChildOf = this.responseExtract(request.params, request.operation, response)
      if (maybeChildOf) {
        obj.needsFinish = true
        const options = {
          childOf: maybeChildOf,
          tags: Object.assign(
            {},
            this.requestTags.get(request) || {},
            { [Tags.SPAN_KIND]: 'server' }
          )
        }
        const span = plugin.tracer.startSpan('aws.response', options)
        this.enter(span, store)
      }
    })

    this.addSub('apm:aws:response:finish:sqs', err => {
      const { span } = storage.getStore()
      this.finish(span, null, err)
    })
  }

  isEnabled (request) {
    if (!super.isEnabled(request)) return false
    if (typeof this.config !== 'object') return true
    const config = typeof this.config.sqs === 'object' ? this.config.sqs : this.config
    switch (request.operation) {
      case 'receiveMessage':
        return config.consumer !== false
      case 'sendMessage':
      case 'sendMessageBatch':
        return config.producer !== false
      default:
        return true
    }
  }

  generateTags (params, operation, response) {
    const tags = {}

    if (!params || (!params.QueueName && !params.QueueUrl)) return tags

    Object.assign(tags, {
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl
    })

    switch (operation) {
      case 'receiveMessage':
        tags['span.type'] = 'worker'
        tags['span.kind'] = 'consumer'
        break
      case 'sendMessage':
      case 'sendMessageBatch':
        tags['span.kind'] = 'producer'
        break
    }

    return tags
  }

  responseExtract (params, operation, response) {
    if (operation === 'receiveMessage') {
      if (
        (!params.MaxNumberOfMessages || params.MaxNumberOfMessages === 1) &&
        response &&
        response.Messages &&
        response.Messages[0] &&
        response.Messages[0].MessageAttributes &&
        response.Messages[0].MessageAttributes._datadog &&
        response.Messages[0].MessageAttributes._datadog.StringValue
      ) {
        const textMap = response.Messages[0].MessageAttributes._datadog.StringValue
        try {
          return this.tracer.extract('text_map', JSON.parse(textMap))
        } catch (err) {
          log.error(err)
          return undefined
        }
      }
    }
  }

  requestInject (span, request) {
    const operation = request.operation
    if (operation === 'sendMessage') {
      if (!request.params) {
        request.params = {}
      }
      if (!request.params.MessageAttributes) {
        request.params.MessageAttributes = {}
      } else if (Object.keys(request.params.MessageAttributes).length >= 10) { // SQS quota
        // TODO: add test when the test suite is fixed
        return
      }
      const ddInfo = {}
      this.tracer.inject(span, 'text_map', ddInfo)
      request.params.MessageAttributes._datadog = {
        DataType: 'String',
        StringValue: JSON.stringify(ddInfo)
      }
    }
  }
}

module.exports = Sqs
