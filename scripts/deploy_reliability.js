const AWS = require('aws-sdk')

const DDTRACE_VERSION = require('../packages/dd-trace/lib/version')

const Body = `
${process.env.CIRCLE_BRANCH}
${process.env.CIRCLE_SHA1}
${DDTRACE_VERSION}
${process.env.CIRCLE_USERNAME}
`

const accessKeyId = process.env.RELIABILITY_AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.RELIABILITY_AWS_SECRET_ACCESS_KEY

AWS.config.update({ accessKeyId, secretAccessKey })

const Bucket = 'datadog-reliability-env'
const Key = `node/${process.env.CIRCLE_BRANCH}.txt`

const s3 = new AWS.S3()
s3.client.putObject({ Bucket, Key, Body }, (err, data) => {
  if (err) {
    process.exitCode = 1
    console.error('S3 upload failed because of:')
    console.error(err)
  } else {
    console.log('uploaded:', data.Location)
  }
})
