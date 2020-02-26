'use strict'

const Services = {
  cloudwatchlogs: require('./services/cloudwatchlogs'),
  dynamodb: require('./services/dynamodb'),
  kinesis: require('./services/kinesis'),
  s3: require('./services/s3'),
  redshift: require('./services/redshift'),
  sns: require('./services/sns'),
  sqs: require('./services/sqs'),
  default: require('./services/base')
}

const DEFAULT = 'default'

function getService (serviceName) {
  if (Services[serviceName]) {
    return new Services[serviceName]()
  } else {
    return new Services[DEFAULT]()
  }
}

const helpers = {
  finish (span, err) {
    if (err) {
      span.setTag('error', err)
      this.addRequestIdTag(span, err)
    }

    span.finish()
  },

  addResponseTags (span, response, serviceName, config) {
    if (!span) return

    if (response.request) {
      this.addServicesTags(span, response, serviceName)
    }

    this.addRequestIdTag(span, response)
    config.hooks.request(span, response)
  },

  addServicesTags (span, response, serviceName) {
    if (!span) return

    const params = response.request.params
    const operation = response.request.operation
    const service = getService(serviceName)

    service.addTags(span, params, operation, response)
  },

  addRequestIdTag (span, res) {
    if (!span) return

    if (res.requestId) {
      span.addTags({ 'aws.response.request_id': res.requestId })
    }
  }
}

module.exports = helpers
