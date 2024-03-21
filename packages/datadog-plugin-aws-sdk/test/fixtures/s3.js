'use strict'

const s3 = {}

s3.put = {
  Bucket: 'test-aws-bucket-9bd88aa3-6fc1-44bd-ae3a-ba25f49c3eef',
  Key: 'test.txt',
  Body: 'Hello World!'
}

s3.create = {
  Bucket: 'test-aws-bucket-9bd88aa3-6fc1-44bd-ae3a-ba25f49c3eef'
}

module.exports = s3
