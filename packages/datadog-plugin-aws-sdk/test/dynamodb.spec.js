/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

class TestSpanProcessor {
  constructor () {
    this.unprocessedSpans = []
  }

  process (span) {
    // Store the unprocessed span
    this.unprocessedSpans.push(span)
  }
}

const dynamoParams = {
  TableName: 'example-table',
  KeySchema: [
    { AttributeName: 'id', KeyType: 'HASH' }
  ],
  AttributeDefinitions: [
    { AttributeName: 'id', AttributeType: 'S' }
  ],
  ProvisionedThroughput: {
    ReadCapacityUnits: 5,
    WriteCapacityUnits: 5
  }
}

let tracer

describe('DynamoDB', function () {
  this.timeout(100000)
  describe('aws-sdk (dynamodb)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk'], (version, moduleName) => {
      let AWS
      let dynamo

      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/${moduleName}@${version}`).get()

          dynamo = new AWS.DynamoDB({
            endpoint: 'http://127.0.0.1:4566',
            region: 'us-west-2'
          })

          const testSpanProcessor = new TestSpanProcessor()
          tracer._tracer._processor = testSpanProcessor

          done()
        })

        after(done => {
          tracer._tracer._processor.unprocessedSpans = []
          dynamo.deleteTable({ TableName: 'example-table' }, done)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should run the createTable in the context of its span', async () => {
          // Convert the createTable function to a Promise-based function
          const createTablePromise = (params) => {
            return new Promise((resolve, reject) => {
              dynamo.createTable(params, (err, data) => {
                if (err) reject(err)
                else resolve(data)
              })
            })
          }

          // Await the createTable function
          await createTablePromise(dynamoParams)
          const span = tracer._tracer._processor.unprocessedSpans[0]

          expect(span.context()._tags['aws.operation']).to.equal('createTable')
          expect(span.context()._tags['tablename']).to.equal('example-table')
          expect(span.context()._tags['aws_service']).to.equal('DynamoDB')
          expect(span.context()._tags['region']).to.equal('us-west-2')
        })
      })
    })
  })
})
