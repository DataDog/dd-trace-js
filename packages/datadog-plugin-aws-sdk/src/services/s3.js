'use strict'

const BaseAwsSdkPlugin = require('../base')
const {
  SPAN_LINK_KIND,
  S3_PTR_KIND,
  generateS3PointerHash
} = require('../../../dd-trace/src/span_pointers')
const { SPAN_POINTER_DIRECTION } = require('../../../dd-trace/src/span_pointers')

class S3 extends BaseAwsSdkPlugin {
  static get id () { return 's3' }
  static get peerServicePrecursors () { return ['bucketname'] }
  static get isPayloadReporter () { return true }

  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.Bucket) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.Bucket}`,
      'aws.s3.bucket_name': params.Bucket,
      bucketname: params.Bucket
    })
  }

  addSpanPointer (span, response) {
    const request = response?.request
    const operationName = request?.operation
    if (!['putObject', 'copyObject', 'completeMultipartUpload'].includes(operationName)) {
      // We don't create span links for other S3 operations.
      return
    }

    const bucketName = request?.params?.Bucket
    const objectKey = request?.params?.Key
    // AWS v2 (all 3 operations): `response.data.ETag`
    // AWS v3 (putObject & completeMultipartUpload): `response.ETag`
    // AWS v3 (copyObject): `response.CopyObjectResult.ETag`
    const eTag = response?.data?.ETag || response?.ETag || response?.CopyObjectResult?.ETag

    const pointerHash = generateS3PointerHash(bucketName, objectKey, eTag)
    if (pointerHash) {
      const attributes = {
        'ptr.kind': S3_PTR_KIND,
        'ptr.dir': SPAN_POINTER_DIRECTION.DOWNSTREAM,
        'ptr.hash': pointerHash,
        'link.kind': SPAN_LINK_KIND
      }
      span.addSpanPointer(attributes)
    }
  }
}

module.exports = S3
