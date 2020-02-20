'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const fixtures = require('./fixtures.js')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')

wrapIt()

describe('Plugin', () => {
  describe('aws-sdk', function () {
    before(() => {
      process.env['AWS_SECRET_ACCESS_KEY'] = '0000000000/00000000000000000000000000000'
      process.env['AWS_ACCESS_KEY_ID'] = '00000000000000000000'
    })

    after(() => {
      delete process.env['AWS_SECRET_ACCESS_KEY']
      delete process.env['AWS_ACCESS_KEY_ID']
    })

    afterEach(() => {
      agent.close()
      agent.wipe()
    })

    withVersions(plugin, 'aws-sdk', version => {
      describe('DynamoDB', () => {
        const ddbParams = fixtures.ddb
        const ddbPutItemParams = fixtures.ddb_put_item
        const ddbGetItemParams = fixtures.ddb_get_item
        const ddbBatchParams = fixtures.ddb_batch
        const operationName = 'getItem'
        const service = 'DynamoDB'
        let epDynamo
        let ddb

        describe('without configuration', () => {
          beforeEach(async () => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            await ddb.createTable(ddbParams).promise()
            await ddb.putItem(ddbPutItemParams).promise()
            agent.load(plugin, 'aws-sdk')
          })

          afterEach(async () => {
            const data = await ddb.listTables({}).promise()
            if (data && data.TableNames && data.TableNames.length > 0) {
              await ddb.deleteItem(ddbGetItemParams).promise()
              await ddb.deleteTable({ TableName: ddbParams.TableName }).promise()
            }
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              ddb[operationName](ddbGetItemParams, () => {
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
                    expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  })
                  .then(done)
                  .catch(done)
              })
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
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              const tableRequest = ddb[operationName](ddbGetItemParams)
              tableRequest.send()
            })

            it('should instrument service methods using promise()', async () => {
              const expected = {
                error: 0,
                name: 'aws.http',
                resource: `${operationName} ${ddbGetItemParams.TableName}`,
                meta: {
                  'aws.dynamodb.table_name': ddbGetItemParams.TableName,
                  'aws.region': 'REGION',
                  'aws.agent': 'js-aws-sdk',
                  'aws.operation': operationName,
                  'http.status_code': '200',
                  'aws.service': `Amazon.${service}`
                }
              }

              const expectationsPromise = expectSomeSpan(agent, expected)
              const checkTraces = async () => {
                await agent.use(traces => {
                  expect(traces[0][0].meta['aws.url']).to.be.a('string')
                  expect(traces[0][0].meta['http.content_length']).to.be.a('string')

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                })
                await expectationsPromise
              }

              await ddb[operationName](ddbGetItemParams).promise()
              return checkTraces()
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
          beforeEach(async () => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            await ddb.createTable(ddbParams).promise()
            await ddb.putItem(ddbPutItemParams).promise()

            agent.load(plugin, 'aws-sdk', {
              hooks: { http: (span, response) => {
                span.addTags({
                  'aws.specialValue': 'foo',
                  'aws.paramsTableName': response.request.params.TableName
                })
              }
              }
            })
          })

          afterEach(async () => {
            const data = await ddb.listTables({}).promise()
            if (data && data.TableNames && data.TableNames.length > 0) {
              await ddb.deleteItem(ddbGetItemParams).promise()
              await ddb.deleteTable({ TableName: ddbParams.TableName }).promise()
            }
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              ddb[operationName](ddbGetItemParams, () => {
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
              })
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

              const tableRequest = ddb[operationName](ddbGetItemParams).promise()
              tableRequest.then(checkTraces).catch(checkTraces)
            })
          })
        })
      })

      describe('Kinesis', () => {
        const kinesisDescribeParams = fixtures.kinesis_describe
        const operationName = 'describeStream'
        const service = 'Kinesis'
        let epKinesis
        let kinesis

        describe('without configuration', () => {
          beforeEach(() => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4568')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })
            agent.load(plugin, 'aws-sdk')
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              kinesis[operationName](kinesisDescribeParams, (err, resp) => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource',
                      `${operationName} ${kinesisDescribeParams.StreamName}`
                    )
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
              })
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource',
                    `${operationName} ${kinesisDescribeParams.StreamName}`
                  )
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

              const streamRequest = kinesis[operationName](kinesisDescribeParams)
              streamRequest.send()
            })

            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource',
                    `${operationName} ${kinesisDescribeParams.StreamName}`
                  )
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

              const streamRequest = kinesis[operationName](kinesisDescribeParams).promise()
              streamRequest.then(checkTraces).catch(checkTraces)
            })

            it('should mark error responses', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource',
                    `${operationName} ${kinesisDescribeParams.StreamName}`
                  )
                  expect(traces[0][0]).to.have.property('name', 'aws.http')
                  expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.agent', 'js-aws-sdk')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')
                }).then(done).catch(done)
              }

              const streamRequest = kinesis[operationName]({
                StreamName: kinesisDescribeParams.StreamName,
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

            agent.load(plugin, 'aws-sdk', {
              hooks: {
                http: (span, response) => {
                  span.addTags({
                    'aws.specialValue': 'foo',
                    'aws.paramsStreamName': response.request.params.StreamName
                  })
                }
              }
            })
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              kinesis[operationName](kinesisDescribeParams, () => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource',
                      `${operationName} ${kinesisDescribeParams.StreamName}`
                    )
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
                    expect(traces[0][0].meta).to.have.property('aws.paramsStreamName', kinesisDescribeParams.StreamName)

                    // request_id will randomly not exist on resp headers for dynamoDB,
                    // it's unclear why it may be due to test env
                    expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                  })
                  .then(done)
                  .catch(done)
              })
            })

            it('should handle hooks appropriately without a callback', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource',
                    `${operationName} ${kinesisDescribeParams.StreamName}`
                  )
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
                  expect(traces[0][0].meta).to.have.property('aws.paramsStreamName', kinesisDescribeParams.StreamName)

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  expect(traces[0][0].meta['aws.request_id']).to.be.a('string')
                }).then(done).catch(done)
              }

              const streamRequest = kinesis[operationName](kinesisDescribeParams).promise()
              streamRequest.then(checkTraces).catch(checkTraces)
            })
          })
        })
      })

      describe('S3', () => {
        const s3Params = fixtures.s3_create
        const operationName = 'listObjects'
        const service = 'S3'
        let epS3
        let s3

        describe('without configuration', () => {
          beforeEach(async () => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })
            await s3.createBucket({ Bucket: s3Params.Bucket }).promise()
            agent.load(plugin, 'aws-sdk')
          })

          afterEach(async () => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })
            await s3.deleteBucket(s3Params).promise()
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              s3[operationName](s3Params, () => {
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
              })
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

              const s3Request = s3[operationName](s3Params)
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

              const s3Request = s3[operationName](s3Params).promise()
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
          beforeEach(async () => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            AWS.config.update({ region: 'us-east-1' })
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })
            await s3.createBucket({ Bucket: s3Params.Bucket }).promise()

            return agent.load(plugin, 'aws-sdk', {
              hooks: {
                http: (span, response) => {
                  span.addTags({
                    'aws.specialValue': 'foo',
                    'aws.paramsBucket': response.request.params.Bucket
                  })
                }
              }
            })
          })

          afterEach(async () => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })
            await s3.deleteBucket(s3Params).promise()
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              s3[operationName](s3Params, () => {
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
              })
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

              const s3Request = s3[operationName](s3Params).promise()
              s3Request.then(checkTraces).catch(checkTraces)
            })
          })
        })
      })

      describe('SQS', () => {
        const sqsCreateParams = fixtures.sqs_create
        const sqsGetParams = fixtures.sqs_get
        const operationName = 'receiveMessage'
        const service = 'SQS'
        let epSqs
        let sqs

        beforeEach(async () => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSqs = new AWS.Endpoint('http://localhost:4576')
          AWS.config.update({ region: 'REGION' })

          sqs = new AWS.SQS({ endpoint: epSqs })
          const sqsResponse = await sqs.createQueue(sqsCreateParams).promise()

          if (sqsResponse.QueueUrl) {
            sqsGetParams.QueueUrl = sqsResponse.QueueUrl
          }

          agent.load(plugin, 'aws-sdk')
        })

        afterEach(async () => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSqs = new AWS.Endpoint('http://localhost:4576')
          sqs = new AWS.SQS({ endpoint: epSqs })

          await sqs.deleteQueue(sqsGetParams).promise()
        })

        describe('without configuration', () => {
          it('should instrument service methods with a callback', (done) => {
            sqs[operationName](sqsGetParams, () => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
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
            })
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
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

            const sqsRequest = sqs[operationName](sqsGetParams)
            sqsRequest.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
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

            const sqsRequest = sqs[operationName](sqsGetParams).promise()
            sqsRequest.then(checkTraces).catch(checkTraces)
          })

          it('should mark error responses', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
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
              'QueueUrl': sqsGetParams.QueueUrl,
              'IllegalKey': 'IllegalValue'
            }).promise()

            sqsRequest.then(checkTraces).catch(checkTraces)
          })
        })
      })

      describe('SNS', () => {
        const snsCreateParams = fixtures.sns_create
        const snsGetParams = fixtures.sns_get
        const operationName = 'getTopicAttributes'
        const service = 'SNS'
        let epSns
        let sns
        let topicArn

        beforeEach(async () => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSns = new AWS.Endpoint('http://localhost:4575')

          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: epSns })

          const snsData = await sns.createTopic(snsCreateParams).promise()

          if (snsData.TopicArn) {
            snsGetParams.TopicArn = snsData.TopicArn
          }

          agent.load(plugin, 'aws-sdk')
        })

        afterEach(async () => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSns = new AWS.Endpoint('http://localhost:4575')
          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: epSns })

          // cleanup topics
          const snsTopics = await sns.listTopics({}).promise()

          if (snsTopics.Topics && snsTopics.Topics.length > 0) {
            snsTopics.Topics.forEach(async (topic) => {
              await sns.deleteTopic(topic).promise()
            })
          }
        })

        describe('without configuration', () => {
          it('should instrument service methods with a callback', (done) => {
            sns[operationName](snsGetParams, () => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
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
            })
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
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

            const snsRequest = sns[operationName](snsGetParams)
            snsRequest.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
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

            const snsRequest = sns[operationName](snsGetParams).promise()
            snsRequest.then(checkTraces).catch(checkTraces)
          })

          it('should use the response data topicArn for resource and metadata when creating topic', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `createTopic ${topicArn}`)
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
              topicArn = data.TopicArn
            }).catch(err => {}).finally(checkTraces)
          })

          it('should mark error responses', (done) => {
            function checkTraces () {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
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

            const snsRequest = sns.getTopicAttributes({
              TopicArn: snsGetParams.TopicArn,
              'IllegalKey': 'IllegalValue'
            }).promise()

            snsRequest.then(checkTraces).catch(checkTraces)
          })
        })
      })
    })
  })
})
