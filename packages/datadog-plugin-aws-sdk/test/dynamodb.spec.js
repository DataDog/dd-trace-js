'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const axios = require('axios');

const tableName = 'dynamodb-table-name-test'

describe('Plugin', () => {
  describe('aws-sdk (dynamodb)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], '2.3.0', (version, moduleName) => {
      let AWS
      let dynamoDB
      let tracer

      const dynamoDBClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-dynamodb' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(async() => {
          AWS = require(`../../../versions/${dynamoDBClientName}@${version}`).get()

          dynamoDB = new AWS.DynamoDB({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          await dynamoDB.createTable({
            TableName: tableName,
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
          }).promise();
        })

        after(async() => {
          await dynamoDB.deleteTable({ TableName: tableName }).promise();
        })

        after(async() => {
          return agent.close({ ritmReset: false })
        })

        it('should allow disabling a specific span kind of a service', (done) => {
          let total = 0
        
          agent.use(traces => {
            const span = traces[0][0]
            expect(span).to.include({
              name: 'aws.request',
              resource: `putItem ${tableName}`
            })
        
            expect(span.meta).to.include({
              'tablename': tableName,
              'aws_service': 'DynamoDB',
              'region': 'us-east-1'
            })
        
            total++
          }).catch(() => {}, { timeoutMs: 100 })
        
          dynamoDB.putItem({
            TableName: tableName,
            Item: {
              id: { S: 'test-id' },
              data: { S: 'test-data' }
            }
          }, (err) => {
            if (err) return done(err)

            setTimeout(() => {
              try {
                expect(total).to.equal(1)
                done()
              } catch (e) {
                done(e)
              }
            }, 250)
          })
        })
      })
    })
  })
})
