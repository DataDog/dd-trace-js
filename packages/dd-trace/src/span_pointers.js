const crypto = require('crypto')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

const SPAN_LINK_KIND = 'span-pointer'
const S3_PTR_KIND = 'aws.s3.object'

// Span context with ids of 0 is used for span pointers
const ZERO_CONTEXT = new SpanContext({
  traceId: id('0'),
  spanId: id('0')
})

const SPAN_POINTER_DIRECTION = Object.freeze({
  UPSTREAM: 'u',
  DOWNSTREAM: 'd'
})

/**
 * Generates a unique hash for an S3 object using its bucket name, key, and ETag
 * https://github.com/DataDog/dd-span-pointer-rules/blob/main/AWS/S3/Object/README.md
 * @param {string} bucketName - The name of the S3 bucket containing the object
 * @param {string} objectKey - The full path/key of the object in the bucket
 * @param {string} eTag - The ETag value from S3, which may be wrapped in quotes
 * @returns {string|null} A hash uniquely identifying the S3 request, or null if missing parameters.
 */
function generateS3PointerHash (bucketName, objectKey, eTag) {
  if (!bucketName || !objectKey || !eTag) {
    return null
  }

  if (eTag.startsWith('"') && eTag.endsWith('"')) {
    eTag = eTag.slice(1, -1)
  }
  const dataToHash = `${bucketName}|${objectKey}|${eTag}`
  const hash = crypto.createHash('sha256').update(dataToHash).digest('hex')
  return hash.substring(0, 32)
}

module.exports = {
  ZERO_CONTEXT,
  SPAN_LINK_KIND,
  S3_PTR_KIND,
  SPAN_POINTER_DIRECTION,
  generateS3PointerHash
}
