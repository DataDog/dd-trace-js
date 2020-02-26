'use strict'

const BaseService = require('./base')

class SnsService extends BaseService {
  _addServiceTags (params, operation, response) {
    const tags = {}

    if (!params) return tags

    // sns topic
    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return tags

    // SNS.createTopic is invoked with name but returns full arn in response data
    // which is used elsewhere to refer to topic
    return Object.assign(tags, {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': params.TopicArn || response.data.TopicArn
    })

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }
}

module.exports = SnsService
