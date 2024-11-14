'use strict'

const BaseAwsSdkPlugin = require('../base')
const {
  SPAN_LINK_KIND,
  S3_PTR_KIND,
  generateS3PointerHash
} = require('../../../dd-trace/src/span_pointers')
const { SPAN_POINTER_DIRECTION } = require('../../../dd-trace/src/span_pointers')
const log = require('../../../dd-trace/src/log')

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

  addSpanPointers (span, response) {
    const request = response?.request
    const operationName = request?.operation
    if (!['putObject', 'copyObject', 'completeMultipartUpload'].includes(operationName)) {
      // We don't create span links for other S3 operations.
      return
    }

    // AWS v2: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html
    // AWS v3: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/
    const bucketName = request?.params?.Bucket
    const objectKey = request?.params?.Key
    const eTag =
      response?.ETag || // v3 PutObject & CompleteMultipartUpload
      response?.CopyObjectResult?.ETag || // v3 CopyObject
      response?.data?.ETag || // v2 PutObject & CompleteMultipartUpload
      response?.data?.CopyObjectResult?.ETag // v2 CopyObject

    if (!bucketName || !objectKey || !eTag) {
      log.debug('Unable to calculate span pointer hash because of missing parameters.')
      return
    }

    const pointerHash = generateS3PointerHash(bucketName, objectKey, eTag)
    const attributes = {
      'ptr.kind': S3_PTR_KIND,
      'ptr.dir': SPAN_POINTER_DIRECTION.DOWNSTREAM,
      'ptr.hash': pointerHash,
      'link.kind': SPAN_LINK_KIND
    }
    span.addSpanPointer(attributes)
  }
}

module.exports = S3
