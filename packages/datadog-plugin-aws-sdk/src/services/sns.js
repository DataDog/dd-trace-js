'use strict'

class Sns {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params) return tags

    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': params.TopicArn || response.data.TopicArn
    })

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }
}

module.exports = Sns
