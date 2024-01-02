'use strict'

const id = require('../../dd-trace/src/id')

const dataBuffer = Buffer.from(JSON.stringify({
  custom: 'data',
  for: 'my users',
  from: 'Aaron Stuyvenberg'
}))

function getTestData (kinesis, input, cb) {
  getTestRecord(kinesis, input, (err, data) => {
    if (err) return cb(err)

    const dataBuffer = Buffer.from(data.Records[0].Data).toString()

    try {
      cb(null, JSON.parse(dataBuffer))
    } catch (e) {
      cb(null, dataBuffer)
    }
  })
}

function getTestRecord (kinesis, { ShardId, SequenceNumber }, cb) {
  kinesis.getShardIterator({
    ShardId,
    ShardIteratorType: 'AT_SEQUENCE_NUMBER',
    StartingSequenceNumber: SequenceNumber,
    StreamName: 'MyStream'
  }, (err, { ShardIterator } = {}) => {
    if (err) return cb(err)

    kinesis.getRecords({
      ShardIterator
    }, cb)
  })
}

function putTestRecord (kinesis, data, cb) {
  kinesis.putRecord({
    PartitionKey: id().toString(),
    Data: data,
    StreamName: 'MyStream'
  }, cb)
}

function waitForActiveStream (mocha, kinesis, cb) {
  kinesis.describeStream({
    StreamName: 'MyStream'
  }, (err, data) => {
    if (err) {
      mocha.timeout(2000)
      return waitForActiveStream(mocha, kinesis, cb)
    }
    if (data.StreamDescription.StreamStatus !== 'ACTIVE') {
      mocha.timeout(2000)
      return waitForActiveStream(mocha, kinesis, cb)
    }

    cb()
  })
}

function waitForDeletedStream (kinesis, cb) {
  kinesis.describeStream({
    StreamName: 'MyStream'
  }, (err, data) => {
    if (!err) return waitForDeletedStream(kinesis, cb)
    cb()
  })
}

module.exports = {
  dataBuffer,
  getTestData,
  getTestRecord,
  putTestRecord,
  waitForActiveStream,
  waitForDeletedStream
}
