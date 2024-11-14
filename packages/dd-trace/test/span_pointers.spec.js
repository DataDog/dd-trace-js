'use strict'

require('./setup/tap')

const {
  SPAN_LINK_KIND,
  S3_PTR_KIND,
  SPAN_POINTER_DIRECTION,
  generateS3PointerHash
} = require('../../dd-trace/src/span_pointers')

describe('span_pointers', () => {
  // datadog-lambda-js imports these and will error if they are not found (moved or renamed)
  describe('constants', () => {
    it('should export the correct constant values', () => {
      expect(SPAN_LINK_KIND).to.equal('span-pointer')
      expect(S3_PTR_KIND).to.equal('aws.s3.object')
      expect(SPAN_POINTER_DIRECTION.UPSTREAM).to.equal('u')
      expect(SPAN_POINTER_DIRECTION.DOWNSTREAM).to.equal('d')
    })
  })

  describe('generateS3PointerHash', () => {
    it('should generate a valid hash for a basic S3 object', () => {
      const hash = generateS3PointerHash('some-bucket', 'some-key.data', 'ab12ef34')
      expect(hash).to.equal('e721375466d4116ab551213fdea08413')
    })

    it('should generate a valid hash for an S3 object with a non-ascii key', () => {
      const hash1 = generateS3PointerHash('some-bucket', 'some-key.你好', 'ab12ef34')
      expect(hash1).to.equal('d1333a04b9928ab462b5c6cadfa401f4')
    })

    it('should generate a valid hash for multipart-uploaded S3 object', () => {
      const hash1 = generateS3PointerHash('some-bucket', 'some-key.data', 'ab12ef34-5')
      expect(hash1).to.equal('2b90dffc37ebc7bc610152c3dc72af9f')
    })

    it('should handle quoted ETags', () => {
      const hash1 = generateS3PointerHash('bucket', 'key', 'etag')
      const hash2 = generateS3PointerHash('bucket', 'key', '"etag"')
      expect(hash1).to.equal(hash2)
    })
  })
})
