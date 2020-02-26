'use strict'

const BaseService = require('./base')

class KinesisService extends BaseService {
  _addServiceTags (params, operation, response) {
    const tags = {}

    if (!params || !params.StreamName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName
    })
  }
}

module.exports = KinesisService
