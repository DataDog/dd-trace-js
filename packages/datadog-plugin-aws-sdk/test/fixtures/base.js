'use strict'

const fixtures = {
  cloudwatchlogs: require('./cloudwatchlogs'),
  dynamodb: require('./dynamodb'),
  kinesis: require('./kinesis'),
  s3: require('./s3'),
  redshift: require('./redshift'),
  sns: require('./sns'),
  sqs: require('./sqs')
}

module.exports = fixtures
