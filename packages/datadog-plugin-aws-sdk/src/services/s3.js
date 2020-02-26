'use strict'

const BaseService = require('./base')

class S3Service extends BaseService {
  _addServiceTags (params, operation, response) {
    const tags = {}

    // s3 Bucket
    if (!params || !params.Bucket) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.Bucket}`,
      'aws.s3.bucket_name': params.Bucket
    })
  }
}

module.exports = S3Service
