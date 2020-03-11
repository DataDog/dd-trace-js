'use strict'

const services = {
  cloudwatchlogs: getService('cloudwatchlogs'),
  dynamodb: getService('dynamodb'),
  kinesis: getService('kinesis'),
  s3: getService('s3'),
  redshift: getService('redshift'),
  sns: getService('sns'),
  sqs: getService('sqs')
}

function getService (serviceName) {
  const Service = require(`./services/${serviceName}`)
  return new Service()
}

const helpers = {
  finish (span, err) {
    if (err) {
      span.setTag('error', err)

      if (err.requestId) {
        span.addTags({ 'aws.response.request_id': err.requestId })
      }
    }

    span.finish()
  },

  addResponseTags (span, response, serviceName, config) {
    if (!span) return

    if (response.request) {
      this.addServicesTags(span, response, serviceName)
    }

    config.hooks.request(span, response)
  },

  addServicesTags (span, response, serviceName) {
    if (!span) return

    const params = response.request.params
    const operation = response.request.operation
    const extraTags = services[serviceName] ? services[serviceName].generateTags(params, operation, response) : {}
    const tags = Object.assign({
      'aws.response.request_id': response.requestId,
      'resource.name': operation
    }, extraTags)

    span.addTags(tags)
  }
}

module.exports = helpers
