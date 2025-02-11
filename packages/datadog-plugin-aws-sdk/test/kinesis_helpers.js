'use strict'

const id = require('../../dd-trace/src/id')

const dataBuffer = Buffer.from(JSON.stringify({
  custom: 'data',
  for: 'my users',
  from: 'Aaron Stuyvenberg'
}))

const dataBufferCustom = (n) => {
  return Buffer.from(JSON.stringify({
    number: n,
    custom: 'data',
    for: 'my users',
    from: 'Aaron Stuyvenberg'
  }))
}

function getTestData (kinesis, streamName, input, cb) {
  getTestRecord(kinesis, streamName, input, (err, data) => {
    if (err) return cb(err)

    const dataBuffer = Buffer.from(data.Records[0].Data).toString()

    try {
      cb(null, JSON.parse(dataBuffer))
    } catch (e) {
      cb(null, dataBuffer)
    }
  })
}

function getTestRecord (kinesis, streamName, { ShardId, SequenceNumber }, cb) {
  kinesis.getShardIterator({
    ShardId,
    ShardIteratorType: 'AT_SEQUENCE_NUMBER',
    StartingSequenceNumber: SequenceNumber,
    StreamName: streamName
  }, (err, { ShardIterator } = {}) => {
    if (err) return cb(err)

    kinesis.getRecords({
      ShardIterator
    }, cb)
  })
}

function putTestRecord (kinesis, streamName, data, cb) {
  kinesis.putRecord({
    PartitionKey: id().toString(),
    Data: data,
    StreamName: streamName
  }, cb)
}

function putTestRecords (kinesis, streamName, cb) {
  waitForActiveStream(kinesis, streamName, () => {
    kinesis.putRecords({
      Records: [
        {
          PartitionKey: id().toString(),
          Data: dataBufferCustom(1)
        },
        {
          PartitionKey: id().toString(),
          Data: dataBufferCustom(2)
        },
        {
          PartitionKey: id().toString(),
          Data: dataBufferCustom(3)
        }
      ],
      StreamName: streamName
    }, cb)
  })
}

function waitForActiveStream (kinesis, streamName, cb) {
  kinesis.describeStream({
    StreamName: streamName
  }, (err, data) => {
    if (err) {
      return waitForActiveStream(kinesis, streamName, cb)
    }
    if (data.StreamDescription.StreamStatus !== 'ACTIVE') {
      return waitForActiveStream(kinesis, streamName, cb)
    }

    cb()
  })
}

function waitForDeletedStream (kinesis, streamName, cb) {
  kinesis.describeStream({
    StreamName: streamName
  }, (err, data) => {
    if (!err) return waitForDeletedStream(kinesis, streamName, cb)
    cb()
  })
}

module.exports = {
  dataBuffer,
  getTestData,
  getTestRecord,
  putTestRecord,
  putTestRecords,
  waitForActiveStream,
  waitForDeletedStream
}
