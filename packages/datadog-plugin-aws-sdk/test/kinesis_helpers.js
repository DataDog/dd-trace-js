'use strict'

const semver = require('semver')

const id = require('../../dd-trace/src/id')

const STREAM_POLL_INTERVAL = 100

const dataBuffer = Buffer.from(JSON.stringify({
  custom: 'data',
  for: 'my users',
  from: 'Aaron Stuyvenberg',
}))

const dataBufferCustom = (n) => {
  return Buffer.from(JSON.stringify({
    number: n,
    custom: 'data',
    for: 'my users',
    from: 'Aaron Stuyvenberg',
  }))
}

function getTestData (kinesis, streamName, input, cb) {
  getTestRecord(kinesis, streamName, input, (err, data) => {
    if (err) return cb(err)

    const dataBuffer = Buffer.from(data.Records[0].Data).toString()

    try {
      cb(null, JSON.parse(dataBuffer))
    } catch {
      cb(null, dataBuffer)
    }
  })
}

function getTestRecord (kinesis, streamName, { ShardId, SequenceNumber }, cb) {
  kinesis.getShardIterator({
    ShardId,
    ShardIteratorType: 'AT_SEQUENCE_NUMBER',
    StartingSequenceNumber: SequenceNumber,
    StreamName: streamName,
  }, (err, { ShardIterator } = {}) => {
    if (err) return cb(err)

    kinesis.getRecords({
      ShardIterator,
    }, cb)
  })
}

function putTestRecord (kinesis, streamName, data, cb) {
  kinesis.putRecord({
    PartitionKey: id().toString(),
    Data: data,
    StreamName: streamName,
  }, cb)
}

function putTestRecords (kinesis, streamName, cb) {
  waitForActiveStream(kinesis, streamName, () => {
    kinesis.putRecords({
      Records: [
        {
          PartitionKey: id().toString(),
          Data: dataBufferCustom(1),
        },
        {
          PartitionKey: id().toString(),
          Data: dataBufferCustom(2),
        },
        {
          PartitionKey: id().toString(),
          Data: dataBufferCustom(3),
        },
      ],
      StreamName: streamName,
    }, cb)
  })
}

function waitForActiveStream (kinesis, streamName, cb) {
  kinesis.describeStream({
    StreamName: streamName,
  }, (err, data) => {
    if (err || data.StreamDescription.StreamStatus !== 'ACTIVE') {
      return setTimeout(waitForActiveStream, STREAM_POLL_INTERVAL, kinesis, streamName, cb)
    }

    cb()
  })
}

function waitForDeletedStream (kinesis, streamName, cb) {
  kinesis.describeStream({
    StreamName: streamName,
  }, (err, data) => {
    if (!err) return setTimeout(waitForDeletedStream, STREAM_POLL_INTERVAL, kinesis, streamName, cb)
    cb()
  })
}

/**
 * Whether the Kinesis client sends `StreamARN`: `aws-sdk` v2 rejects the member as unknown before it was modelled, and
 * `@aws-sdk/client-kinesis` below 3.232.0 drops it while serializing, so the request names no stream.
 *
 * @param {string} kinesisClientName
 * @param {string} version Version range the test installed the client for.
 */
function sendsStreamArn (kinesisClientName, version) {
  if (kinesisClientName !== '@aws-sdk/client-kinesis') return false
  const clientVersion = require(`../../../versions/${kinesisClientName}@${version}`).version()
  return semver.gte(clientVersion, '3.232.0')
}

module.exports = {
  dataBuffer,
  getTestData,
  getTestRecord,
  putTestRecord,
  putTestRecords,
  sendsStreamArn,
  waitForActiveStream,
  waitForDeletedStream,
}
