'use strict'

const BaseAwsSdkPlugin = require('../base')

class S3 extends BaseAwsSdkPlugin {
  static get id () { return 's3' }
  static get peerServicePrecursors () { return ['bucketname'] }

  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.Bucket) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.Bucket}`,
      'aws.s3.bucket_name': params.Bucket,
      bucketname: params.Bucket
    })
  }
}

module.exports = S3
