'use strict'

class S3 {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.Bucket) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.Bucket}`,
      'aws.s3.bucket_name': params.Bucket
    })
  }
}

module.exports = S3
