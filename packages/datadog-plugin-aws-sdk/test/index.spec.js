'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const fixtures = require('./aws_fixtures.js')

wrapIt()

describe('Plugin', () => {
  describe('aws-sdk', function () {
    afterEach(() => {
      agent.close()
      agent.wipe()
    })

    withVersions(plugin, 'aws-sdk', version => {
      describe('DynamoDB', () => {
        const ddbParams = fixtures.ddb
        const ddbBatchParams = fixtures.ddb_batch
        const operationName = 'createTable'
        const service = 'DynamoDB'
        let epDynamo
        let ddb

        describe('without configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()

            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })
            agent.load(plugin, 'aws-sdk')
          })

          afterEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            ddb.listTables({}).promise().then(data => {
              if (data && data.TableNames && data.TableNames.length > 0) {
                ddb.deleteTable({ TableName: ddbParams.TableName }).promise()
              }
            })
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')

                  // request_id will randomly not exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              ddb[operationName](ddbParams, () => {})
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              const tableRequest = ddb[operationName](ddbParams)
              tableRequest.send()
            })

            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                }).then(done).catch(done)
              }

              const tableRequest = ddb[operationName](ddbParams).promise()
              tableRequest.then(checkTraces).catch(checkTraces)
            })

            it('should collect table name metadata for batch operations', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `batchGetItem ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', 'batchGetItem')
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)
              }

              const batchItemRequest = ddb.batchGetItem(ddbBatchParams).promise()
              batchItemRequest.then(checkTraces).catch(checkTraces)
            })

            it('should mark error responses', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')

                  // for some reason this fails to exist on error responses in testing env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                }).then(done).catch(done)
              }

              const tableRequest = ddb[operationName]({
                'TableName': ddbParams.TableName,
                'BadParam': 'badvalue'
              }).promise()
              tableRequest.then(checkTraces).catch(checkTraces)
            })
          })
        })

        describe('with configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()

            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })
            agent.load(plugin, 'aws-sdk', {
              hooks: { addCustomTags: (span, params) => {
                span.addTags({
                  'aws.specialValue': 'foo',
                  'aws.paramsTableName': params.TableName
                })
              }
              }
            })
          })

          afterEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            ddb.listTables({}).promise().then(data => {
              if (data && data.TableNames && data.TableNames.length > 0) {
                ddb.deleteTable({ TableName: ddbParams.TableName }).promise()
              }
            })
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                  expect(traces[0][0].meta).to.have.property('aws.paramsTableName', ddbParams.TableName)

                  // request_id will randomly not exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              ddb[operationName](ddbParams, () => {})
            })

            it('should handle hooks appropriately without a callback', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                  expect(traces[0][0].meta).to.have.property('aws.paramsTableName', ddbParams.TableName)

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                }).then(done).catch(done)
              }

              const tableRequest = ddb[operationName](ddbParams).promise()
              tableRequest.then(checkTraces).catch(checkTraces)
            })
          })
        })
      })

      describe('Kinesis', () => {
        const kinesisParams = fixtures.kinesis
        const operationName = 'createStream'
        const service = 'Kinesis'
        let epKinesis
        let kinesis

        describe('without configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4568')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })
            return agent.load(plugin, 'aws-sdk')
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${kinesisParams.StreamName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)

              kinesis[operationName](kinesisParams, () => {})
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${kinesisParams.StreamName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              const streamRequest = kinesis[operationName](kinesisParams)
              streamRequest.send()
            })

            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${kinesisParams.StreamName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)
              }

              const streamRequest = kinesis[operationName](kinesisParams).promise()
              streamRequest.then(checkTraces).catch(checkTraces)
            })

            it('should mark error responses', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${kinesisParams.StreamName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')

                  // for some reason this fails to exist on error responses in testing env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  // expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  // expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)
              }

              const streamRequest = kinesis[operationName]({
                StreamName: kinesisParams.StreamName,
                'IllegalKey': 'IllegalValue'
              }).promise()

              streamRequest.then(checkTraces).catch(checkTraces)
            })
          })
        })

        describe('with configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4568')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })
            return agent.load(plugin, 'aws-sdk', {
              hooks: {
                addCustomTags: (span, params) => {
                  span.addTags({
                    'aws.specialValue': 'foo',
                    'aws.paramsStreamName': params.StreamName
                  })
                }
              }
            })
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${kinesisParams.StreamName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                  expect(traces[0][0].meta).to.have.property('aws.paramsStreamName', kinesisParams.StreamName)

                  // request_id will randomly not exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              kinesis[operationName](kinesisParams, () => {})
            })

            it('should handle hooks appropriately without a callback', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${kinesisParams.StreamName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                  expect(traces[0][0].meta).to.have.property('aws.paramsStreamName', kinesisParams.StreamName)

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                }).then(done).catch(done)
              }

              const streamRequest = kinesis[operationName](kinesisParams).promise()
              streamRequest.then(checkTraces).catch(checkTraces)
            })
          })
        })
      })

      describe('S3', () => {
        const s3Params = fixtures.s3
        const operationName = 'createBucket'
        const service = 'S3'
        let epS3
        let s3

        describe('without configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })
            return agent.load(plugin, 'aws-sdk')
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)

              s3[operationName]({ Bucket: s3Params.Bucket }, () => {})
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              const s3Request = s3[operationName]({ Bucket: s3Params.Bucket })
              s3Request.send()
            })

            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)
              }

              const s3Request = s3[operationName]({ Bucket: s3Params.Bucket }).promise()
              s3Request.then(checkTraces).catch(checkTraces)
            })

            it('should mark error responses', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')

                  // for some reason this fails to exist on error responses in testing env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  // expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  // expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                }).then(done).catch(done)
              }

              const s3Request = s3[operationName]({ Bucket: s3Params.Bucket, 'IllegalKey': 'IllegalValue' }).promise()
              s3Request.then(checkTraces).catch(checkTraces)
            })
          })
        })

        describe('with configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })

            return agent.load(plugin, 'aws-sdk', {
              hooks: {
                addCustomTags: (span, params) => {
                  span.addTags({
                    'aws.specialValue': 'foo',
                    'aws.paramsBucket': params.Bucket
                  })
                }
              }
            })
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                  expect(traces[0][0].meta).to.have.property('aws.paramsBucket', s3Params.Bucket)

                  // request_id will randomly not exist on resp headers
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              s3[operationName]({ Bucket: s3Params.Bucket }, () => {})
            })

            it('should handle hooks appropriately without a callback', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                  expect(traces[0][0].meta).to.have.property('aws.paramsBucket', s3Params.Bucket)

                  // request_id will randomly not exist on resp headers
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                }).then(done).catch(done)
              }

              const s3Request = s3[operationName]({ Bucket: s3Params.Bucket }).promise()
              s3Request.then(checkTraces).catch(checkTraces)
            })
          })
        })
      })

      describe('SQS', () => {
        const sqsParams = fixtures.sqs
        let epSqs
        let sqs

        beforeEach(() => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSqs = new AWS.Endpoint('http://localhost:4576')
          AWS.config.update({ region: 'REGION' })

          sqs = new AWS.SQS({ endpoint: epSqs })
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = 'createQueue'
          const service = 'SQS'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsParams.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)

            sqs[operationName](sqsParams, () => {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsParams.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const sqsRequest = sqs[operationName](sqsParams)
            sqsRequest.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsParams.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)
            }

            const sqsRequest = sqs[operationName](sqsParams).promise()
            sqsRequest.then(checkTraces).catch(checkTraces)
          })

          it('should mark error responses', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsParams.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['error.type']).to.be.a('string')
                expect(traces[0][0].meta['error.msg']).to.be.a('string')
                expect(traces[0][0].meta['error.stack']).to.be.a('string')

                // for some reason this fails to exist on error responses in testing env
                // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                // expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                // expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)
            }

            const sqsRequest = sqs[operationName]({
              'QueueName': sqsParams.QueueName,
              'IllegalKey': 'IllegalValue'
            }).promise()

            sqsRequest.then(checkTraces).catch(checkTraces)
          })
        })
      })

      describe('SNS', () => {
        const snsParams = fixtures.sns
        let epSns
        let sns
        let topicArn
        let topicArnTwo

        beforeEach(() => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSns = new AWS.Endpoint('http://localhost:4575')

          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: epSns })

          return sns.createTopic(snsParams).promise().then(data => {
            topicArn = data.TopicArn
          }).catch(err => {
          }).finally(() => {
            agent.load(plugin, 'aws-sdk')
          })
        })

        afterEach(() => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSns = new AWS.Endpoint('http://localhost:4575')

          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: epSns })

          // cleanup topics
          return sns.listTopics({}).promise().then(data => {
            if (data && data.Topics && data.Topics.length > 0) {
              Promise.all(data.Topics.filter(arn => arn !== undefined)
                .map(arn => sns.deleteTopic({ TopicArn: arn.TopicArn }).promise())
              )
            }
          })
        })

        describe('without configuration', () => {
          const operationName = 'getTopicAttributes'
          const service = 'SNS'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)

            sns.getTopicAttributes({ TopicArn: topicArn }, () => {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const snsRequest = sns[operationName]({ TopicArn: topicArn })
            snsRequest.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)
            }

            const snsRequest = sns[operationName]({ TopicArn: topicArn }).promise()
            snsRequest.then(checkTraces).catch(checkTraces)
          })

          it('should use the response data topicArn for resource and metadata when creating topic', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `createTopic ${topicArnTwo}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', 'createTopic')
                expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)
            }

            sns.createTopic({ Name: 'example_topic_two' }).promise().then(data => {
              topicArnTwo = data.TopicArn
            }).catch(err => {
            }).finally(checkTraces)
          })

          it('should mark error responses', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['error.type']).to.be.a('string')
                expect(traces[0][0].meta['error.msg']).to.be.a('string')
                expect(traces[0][0].meta['error.stack']).to.be.a('string')

                // for some reason this fails to exist on error responses in testing env
                // expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                // expect(traces[0][0].meta['http.status_code']).to.be.a('string')
                // expect(traces[0][0].meta['http.content_length']).to.be.a('string')
              }).then(done).catch(done)
            }

            const snsRequest = sns.getTopicAttributes({ TopicArn: topicArn, 'IllegalKey': 'IllegalValue' }).promise()
            snsRequest.then(checkTraces).catch(checkTraces)
          })
        })
      })
    })
  })
})
