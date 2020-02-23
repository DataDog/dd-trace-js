'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const fixtures = require('./fixtures.js')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const semver = require('semver')

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
        const serviceName = 'dynamodb'
        const className = 'DynamoDB'
        let epDynamo
        let ddb

        describe('without configuration', () => {
          // keeping these non-async as aws-sdk <2.3 doesnt support `.promise()`
          beforeEach((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()

            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            ddb.createTable(ddbParams, () => {
              ddb.putItem(ddbPutItemParams, () => {
                agent.load(plugin, 'aws-sdk')
                done()
              })
            })
          })

          afterEach((done) => {
            ddb.listTables({}, (err, res) => {
              if (res.TableNames && res.TableNames.length > 0) {
                ddb.deleteItem(ddbGetItemParams, () => {
                  ddb.deleteTable({ TableName: ddbParams.TableName }, () => {
                    done()
                  })
                })
              } else {
                done()
              }
            })
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              ddb[operationName](ddbGetItemParams, (err, data) => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')

                    // request_id will randomly not exist on resp headers for dynamoDB,
                    // it's unclear why it may be due to test env
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  })
                  .then(done)
                  .catch(done)
              })
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')

                  // this randomly doesn't exist on resp headers for dynamoDB,
                  // it's unclear why it may be due to test env
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                })
                .then(done)
                .catch(done)

              const tableRequest = ddb[operationName](ddbGetItemParams)
              tableRequest.send()
            })

            if (semver.intersects(version, '>=2.3.0')) {
              it('should instrument service methods using promise()', async () => {
                const expected = {
                  error: 0,
                  name: 'aws.request',
                  resource: `${operationName} ${ddbGetItemParams.TableName}`,
                  meta: {
                    'aws.dynamodb.table_name': ddbGetItemParams.TableName,
                    'aws.region': 'REGION',
                    'aws.operation': operationName,
                    'aws.service': className,
                    'component': 'aws-sdk'
                  }
                }

                const expectationsPromise = expectSomeSpan(agent, expected)
                const checkTraces = async () => {
                  await agent.use(traces => {
                    expect(traces[0][0].meta['aws.url']).to.be.a('string')
                    expect(traces[0][0].service).to.include(serviceName)

                    // this randomly doesn't exist on resp headers for dynamoDB,
                    // it's unclear why it may be due to test env
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  })
                  await expectationsPromise
                }

                await ddb[operationName](ddbGetItemParams).promise()
                return checkTraces()
              })
            }

            it('should collect table name metadata for batch operations', (done) => {
              ddb.batchGetItem(ddbBatchParams, (err, resp) => {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `batchGetItem ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', 'batchGetItem')
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                }).then(done).catch(done)
              })
            })

            it('should mark error responses', (done) => {
              ddb[operationName]({
                'TableName': ddbParams.TableName,
                'BadParam': 'badvalue'
              }, (err, response) => {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')

                  // for some reason this fails to exist on error responses in testing env
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                }).then(done).catch(done)
              })
            })
          })
        })

        describe('with configuration', () => {
          // keeping these non-async as aws-sdk <2.3 doesnt support `.promise()`
          beforeEach((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4569')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            ddb.createTable(ddbParams, () => {
              ddb.putItem(ddbPutItemParams, () => {
                agent.load(plugin, 'aws-sdk', {
                  hooks: { request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      'aws.paramsTableName': response.request.params.TableName
                    })
                  }
                  }
                })
                done()
              })
            })
          })

          afterEach((done) => {
            ddb.listTables({}, (err, res) => {
              if (res.data && res.data.TableNames && res.data.TableNames.length > 0) {
                ddb.deleteItem(ddbGetItemParams, () => {
                  ddb.deleteTable({ TableName: ddbParams.TableName }, () => {
                    done()
                  }).catch(done)
                })
              } else {
                done()
              }
            })
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              ddb[operationName](ddbGetItemParams, () => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                    expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                    expect(traces[0][0].meta).to.have.property('aws.paramsTableName', ddbParams.TableName)

                    // request_id will randomly not exist on resp headers for dynamoDB,
                    // it's unclear why it may be due to test env
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  })
                  .then(done)
                  .catch(done)
              })
            })

            it('should handle hooks appropriately without a callback', (done) => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${ddbParams.TableName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta['aws.dynamodb.table_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                expect(traces[0][0].meta).to.have.property('aws.paramsTableName', ddbParams.TableName)

                // this randomly doesn't exist on resp headers for dynamoDB,
                // it's unclear why it may be due to test env
              }).then(done).catch(done)

              const tableRequest = ddb[operationName](ddbGetItemParams)
              tableRequest.send()
            })
          })
        })
      })

      describe('Kinesis', () => {
        const kinesisDescribeParams = fixtures.kinesis_describe
        const operationName = 'describeStream'
        const serviceName = 'kinesis'
        const className = 'Kinesis'
        let epKinesis
        let kinesis

        describe('without configuration', () => {
          beforeEach((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4568')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })
            agent.load(plugin, 'aws-sdk')
            done()
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              kinesis[operationName](kinesisDescribeParams, (err, resp) => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource',
                      `${operationName} ${kinesisDescribeParams.StreamName}`
                    )
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  }).then(done).catch(done)
              })
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource',
                    `${operationName} ${kinesisDescribeParams.StreamName}`
                  )
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                })
                .then(done)
                .catch(done)

              const streamRequest = kinesis[operationName](kinesisDescribeParams)
              streamRequest.send()
            })

            if (semver.intersects(version, '>=2.3.0')) {
              it('should instrument service methods using promise()', (done) => {
                function checkTraces () {
                  agent.use(traces => {
                    expect(traces[0][0]).to.have.property('resource',
                      `${operationName} ${kinesisDescribeParams.StreamName}`
                    )
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                    expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  }).then(done).catch(done)
                }

                const streamRequest = kinesis[operationName](kinesisDescribeParams).promise()
                streamRequest.then(checkTraces).catch(checkTraces)
              })
            }

            it('should mark error responses', (done) => {
              kinesis[operationName]({
                StreamName: kinesisDescribeParams.StreamName,
                'IllegalKey': 'IllegalValue'
              }, () => {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource',
                    `${operationName} ${kinesisDescribeParams.StreamName}`
                  )
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')
                }).then(done).catch(done)
              })
            })
          })
        })

        describe('with configuration', () => {
          beforeEach((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4568')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })

            agent.load(plugin, 'aws-sdk', {
              hooks: {
                request: (span, response) => {
                  span.addTags({
                    'aws.specialValue': 'foo',
                    'aws.paramsStreamName': response.request.params.StreamName
                  })
                }
              }
            })
            done()
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              kinesis[operationName](kinesisDescribeParams, () => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource',
                      `${operationName} ${kinesisDescribeParams.StreamName}`
                    )
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                    expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                    expect(traces[0][0].meta).to.have.property('aws.paramsStreamName', kinesisDescribeParams.StreamName)

                    // request_id will randomly not exist on resp headers for dynamoDB,
                    // it's unclear why it may be due to test env
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  })
                  .then(done)
                  .catch(done)
              })
            })

            it('should handle hooks appropriately without a callback', (done) => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource',
                  `${operationName} ${kinesisDescribeParams.StreamName}`
                )
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.kinesis.stream_name']).to.be.a('string')
                // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                expect(traces[0][0].meta).to.have.property('aws.paramsStreamName', kinesisDescribeParams.StreamName)

                // this randomly doesn't exist on resp headers for dynamoDB,
                // it's unclear why it may be due to test env
                // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
              }).then(done).catch(done)

              const streamRequest = kinesis[operationName](kinesisDescribeParams)
              streamRequest.send()
            })
          })
        })
      })

      describe('S3', () => {
        const s3Params = fixtures.s3_create
        const operationName = 'listObjects'
        const serviceName = 's3'
        const className = 'S3'
        let epS3
        let s3

        describe('without configuration', () => {
          beforeEach(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })

            s3.createBucket({ Bucket: s3Params.Bucket }, () => {
              agent.load(plugin, 'aws-sdk')
              done()
            })
          })

          afterEach(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })
            s3.deleteBucket(s3Params, () => {
              done()
            })
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              s3[operationName](s3Params, () => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  }).then(done).catch(done)
              })
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                })
                .then(done)
                .catch(done)

              const s3Request = s3[operationName](s3Params)
              s3Request.send()
            })

            if (semver.intersects(version, '>=2.3.0')) {
              it('should instrument service methods using promise()', (done) => {
                function checkTraces () {
                  agent.use(traces => {
                    expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  }).then(done).catch(done)
                }

                const s3Request = s3[operationName](s3Params).promise()
                s3Request.then(checkTraces).catch(checkTraces)
              })
            }

            it('should mark error responses', (done) => {
              s3[operationName]({ Bucket: s3Params.Bucket, 'IllegalKey': 'IllegalValue' }, () => {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                  expect(traces[0][0].meta['error.type']).to.be.a('string')
                  expect(traces[0][0].meta['error.msg']).to.be.a('string')
                  expect(traces[0][0].meta['error.stack']).to.be.a('string')

                  // for some reason this fails to exist on error responses in testing env
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                }).then(done).catch(done)
              })
            })
          })
        })

        describe('with configuration', () => {
          beforeEach(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            AWS.config.update({ region: 'us-east-1' })
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })
            s3.createBucket({ Bucket: s3Params.Bucket }, () => {
              agent.load(plugin, 'aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      'aws.paramsBucket': response.request.params.Bucket
                    })
                  }
                }
              })
              done()
            })
          })

          afterEach(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4572')
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })
            s3.deleteBucket(s3Params, () => {
              done()
            })
          })

          describe('instrumentation', () => {
            it('should handle hooks appropriately with a callback', (done) => {
              s3[operationName](s3Params, () => {
                agent
                  .use(traces => {
                    expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                    expect(traces[0][0]).to.have.property('name', 'aws.request')
                    expect(traces[0][0].service).to.include(serviceName)
                    expect(traces[0][0].meta).to.have.property('aws.service', className)
                    expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                    expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                    expect(traces[0][0].meta['aws.region']).to.be.a('string')
                    expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                    expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                    expect(traces[0][0].meta).to.have.property('aws.paramsBucket', s3Params.Bucket)

                    // request_id will randomly not exist on resp headers
                    // it's unclear why it may be due to test env
                    // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  })
                  .then(done)
                  .catch(done)
              })
            })

            it('should handle hooks appropriately without a callback', (done) => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${s3Params.Bucket}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.s3.bucket_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)

                expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
                expect(traces[0][0].meta).to.have.property('aws.paramsBucket', s3Params.Bucket)

                // request_id will randomly not exist on resp headers
                // it's unclear why it may be due to test env
              }).then(done).catch(done)

              const s3Request = s3[operationName](s3Params)
              s3Request.send()
            })
          })
        })
      })

      describe('SQS', () => {
        const sqsCreateParams = fixtures.sqs_create
        const sqsGetParams = fixtures.sqs_get
        const operationName = 'receiveMessage'
        const serviceName = 'sqs'
        const className = 'SQS'
        let epSqs
        let sqs

        beforeEach(done => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSqs = new AWS.Endpoint('http://localhost:4576')
          AWS.config.update({ region: 'REGION' })

          sqs = new AWS.SQS({ endpoint: epSqs })
          sqs.createQueue(sqsCreateParams, (err, res) => {
            if (res.QueueUrl) {
              sqsGetParams.QueueUrl = res.QueueUrl
            }

            agent.load(plugin, 'aws-sdk')
            done()
          })
        })

        afterEach(done => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSqs = new AWS.Endpoint('http://localhost:4576')
          sqs = new AWS.SQS({ endpoint: epSqs })

          sqs.deleteQueue(sqsGetParams, () => {
            done()
          })
        })

        describe('without configuration', () => {
          it('should instrument service methods with a callback', (done) => {
            sqs[operationName](sqsGetParams, () => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                }).then(done).catch(done)
            })
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
              })
              .then(done)
              .catch(done)

            const sqsRequest = sqs[operationName](sqsGetParams)
            sqsRequest.send()
          })

          if (semver.intersects(version, '>=2.3.0')) {
            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                }).then(done).catch(done)
              }

              const sqsRequest = sqs[operationName](sqsGetParams).promise()
              sqsRequest.then(checkTraces).catch(checkTraces)
            })
          }

          it('should mark error responses', (done) => {
            sqs[operationName]({
              'QueueUrl': sqsGetParams.QueueUrl,
              'IllegalKey': 'IllegalValue'
            }, () => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${sqsGetParams.QueueUrl}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.sqs.queue_name']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['error.type']).to.be.a('string')
                expect(traces[0][0].meta['error.msg']).to.be.a('string')
                expect(traces[0][0].meta['error.stack']).to.be.a('string')

                // for some reason this fails to exist on error responses in testing env
              }).then(done).catch(done)
            })
          })
        })
      })

      describe('SNS', () => {
        const snsCreateParams = fixtures.sns_create
        const snsGetParams = fixtures.sns_get
        const operationName = 'getTopicAttributes'
        const serviceName = 'sns'
        const className = 'SNS'
        let epSns
        let sns
        let topicArn

        beforeEach(done => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSns = new AWS.Endpoint('http://localhost:4575')

          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: epSns })

          sns.createTopic(snsCreateParams, (err, res) => {
            if (res.TopicArn) {
              snsGetParams.TopicArn = res.TopicArn
            }

            agent.load(plugin, 'aws-sdk')
            done()
          })
        })

        afterEach(done => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epSns = new AWS.Endpoint('http://localhost:4575')
          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: epSns })

          // cleanup topics
          sns.listTopics({}, (err, res) => {
            if (res.Topics && res.Topics.length > 0) {
              sns.deleteTopic({ TopicArn: topicArn }, () => {
                done()
              })
            } else {
              done()
            }
          })
        })

        describe('without configuration', () => {
          it('should instrument service methods with a callback', (done) => {
            sns[operationName](snsGetParams, () => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                }).then(done).catch(done)
            })
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
              })
              .then(done)
              .catch(done)

            const snsRequest = sns[operationName](snsGetParams)
            snsRequest.send()
          })

          if (semver.intersects(version, '>=2.3.0')) {
            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                }).then(done).catch(done)
              }

              const snsRequest = sns[operationName](snsGetParams).promise()
              snsRequest.then(checkTraces).catch(checkTraces)
            })
          }

          it('should use the response data topicArn for resource and metadata when creating topic', (done) => {
            sns.createTopic({ Name: 'example_topic_two' }, (err, res) => {
              topicArn = res.TopicArn

              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `createTopic ${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', 'createTopic')
              }).then(done).catch(done)
            })
          })

          it('should mark error responses', (done) => {
            sns.getTopicAttributes({
              TopicArn: snsGetParams.TopicArn,
              'IllegalKey': 'IllegalValue'
            }, () => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName} ${snsGetParams.TopicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['error.type']).to.be.a('string')
                expect(traces[0][0].meta['error.msg']).to.be.a('string')
                expect(traces[0][0].meta['error.stack']).to.be.a('string')

                // for some reason this fails to exist on error responses in testing env
              }).then(done).catch(done)
            })
          })
        })
      })

      describe('General Service', () => {
        // we do not instrument route53 at this time specifically
        // this is meant to demonstrate defaults for non instrumented service
        // if we do later add specific metadata for route53, need to update to a different service
        const operationName = 'listHealthChecks'
        const serviceName = 'route53'
        const className = 'Route53'
        let epRoute53
        let route53

        beforeEach(done => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          epRoute53 = new AWS.Endpoint('http://localhost:4580')
          AWS.config.update({ region: 'us-east-1' })
          route53 = new AWS.Route53({ endpoint: epRoute53 })
          agent.load(plugin, 'aws-sdk')
          done()
        })

        describe('without configuration', () => {
          it('should instrument service methods with a callback', (done) => {
            route53[operationName]({}, (err, response) => {
              agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                }).then(done).catch(done)
            })
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
              })
              .then(done)
              .catch(done)

            const route53Request = route53[operationName]({})
            route53Request.send()
          })

          if (semver.intersects(version, '>=2.3.0')) {
            it('should instrument service methods using promise()', (done) => {
              function checkTraces () {
                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `${operationName}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', className)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  // expect(traces[0][0].meta['aws.response.request_id']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                }).then(done).catch(done)
              }

              const route53Request = route53[operationName]({}).promise()
              route53Request.then(checkTraces).catch(checkTraces)
            })
          }

          it('should mark error responses', (done) => {
            route53[operationName]({
              'IllegalKey': 'IllegalValue'
            }, () => {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.request')
                expect(traces[0][0].service).to.include(serviceName)
                expect(traces[0][0].meta).to.have.property('aws.service', className)
                expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                expect(traces[0][0].meta['aws.region']).to.be.a('string')
                expect(traces[0][0].meta).to.have.property('aws.operation', operationName)
                expect(traces[0][0].meta['error.type']).to.be.a('string')
                expect(traces[0][0].meta['error.msg']).to.be.a('string')
                expect(traces[0][0].meta['error.stack']).to.be.a('string')

                // for some reason this fails to exist on error responses in testing env
              }).then(done).catch(done)
            })
          })
        })

        describe('scope', () => {
          let tracer

          beforeEach(() => {
            tracer = require('../../dd-trace')
          })

          it('should bind child spans to the correct active span', (done) => {
            let activeSpanName

            agent.use(traces => {
              expect(traces[0][0].meta['name']).to.equal(activeSpanName)
            }).then(done).catch(done)

            const tableRequest = route53[operationName]({})

            tableRequest.on('send', () => {
              try {
                activeSpanName = tracer.scope().active()._spanContext.tags._name
              } catch (e) {
                activeSpanName = undefined
              }
            })

            tableRequest.send()
          })

          it('should bind callbacks to the correct active span', (done) => {
            let activeSpanName
            const parentName = 'parent'

            tracer.trace(parentName, () => {
              route53[operationName]({}, () => {
                try {
                  activeSpanName = tracer.scope().active()._spanContext._name
                } catch (e) {
                  activeSpanName = undefined
                }

                expect(activeSpanName).to.equal(parentName)
                done()
              })
            })
          })
        })
      })
    })
  })
})
