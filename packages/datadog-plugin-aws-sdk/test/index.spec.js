'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const fixtures = require('./fixtures/base')
const helpers = require('./spec_helpers')
const semver = require('semver')

wrapIt()

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

const closeAndWipeAgent = async () => {
  await agent.close()
}

describe.only('Plugin', () => {
  describe('aws-sdk', function () {
    before(() => {
      process.env['AWS_SECRET_ACCESS_KEY'] = '0000000000/00000000000000000000000000000'
      process.env['AWS_ACCESS_KEY_ID'] = '00000000000000000000'
    })

    after(() => {
      delete process.env['AWS_SECRET_ACCESS_KEY']
      delete process.env['AWS_ACCESS_KEY_ID']
    })

    withVersions(plugin, 'aws-sdk', version => {
      describe('DynamoDB', () => {
        const ddbParams = fixtures.dynamodb.create
        const ddbPutItemParams = fixtures.dynamodb.put
        const ddbGetItemParams = fixtures.dynamodb.get
        const ddbBatchParams = fixtures.dynamodb.batch
        const operation = 'getItem'
        const serviceName = 'dynamodb'
        const klass = 'DynamoDB'
        const key = 'TableName'
        const metadata = 'dynamodb.table_name'
        const getService = () => { return ddb }
        let epDynamo
        let ddb

        describe('without configuration', () => {
          // keeping these non-async as aws-sdk <2.3 doesnt support `.promise()`
          before((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4566')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            ddb.createTable(ddbParams, () => {
              ddb.putItem(ddbPutItemParams, () => {
                agent.load('aws-sdk').then(done)
              })
            })
          })

          after((done) => {
            ddb.listTables({}, (err, res) => {
              if (res && res.TableNames && res.TableNames.length > 0) {
                ddb.deleteItem(ddbGetItemParams, () => {
                  ddb.deleteTable({ TableName: ddbParams.TableName }, () => {
                    closeAndWipeAgent().then(done)
                  })
                })
              } else {
                closeAndWipeAgent().then(done)
              }
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, ddbGetItemParams, key, metadata)

            it('should collect table name metadata for batch operations', (done) => {
              ddb.batchGetItem(ddbBatchParams, (err, resp) => {
                if (err) return done(err)

                agent.use(traces => {
                  const spans = sort(traces[0])
                  expect(spans[0]).to.have.property('resource', `batchGetItem ${ddbParams.TableName}`)
                  expect(spans[0].service).to.include(serviceName)
                  expect(spans[0].meta).to.have.property('aws.service', klass)
                  expect(spans[0].meta['aws.dynamodb.table_name']).to.be.a('string')
                  expect(spans[0].meta).to.have.property('aws.operation', 'batchGetItem')
                }).then(done).catch(done)
              })
            })
          })
        })

        describe('with configuration', () => {
          // keeping these non-async as aws-sdk <2.3 doesnt support `.promise()`
          before((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epDynamo = new AWS.Endpoint('http://localhost:4566')
            ddb = new AWS.DynamoDB({ endpoint: epDynamo })

            ddb.createTable(ddbParams, () => {
              ddb.putItem(ddbPutItemParams, () => {
                agent.load('aws-sdk', {
                  hooks: { request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                  }
                }).then(done)
              })
            })
          })

          after((done) => {
            ddb.listTables({}, (err, res) => {
              if (res && res.data && res.data.TableNames && res.data.TableNames.length > 0) {
                ddb.deleteItem(ddbGetItemParams, () => {
                  ddb.deleteTable({ TableName: ddbParams.TableName }, () => {
                    closeAndWipeAgent().then(done)
                  })
                })
              } else {
                closeAndWipeAgent().then(done)
              }
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, ddbGetItemParams, key, metadata, true)
          })
        })
      })

      describe('Kinesis', () => {
        const kinesisParams = fixtures.kinesis.describe
        const operation = 'describeStream'
        const serviceName = 'kinesis'
        const klass = 'Kinesis'
        const key = 'StreamName'
        const metadata = 'kinesis.stream_name'
        const getService = () => { return kinesis }
        let epKinesis
        let kinesis

        describe('without configuration', () => {
          before((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4566')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })
            agent.load('aws-sdk').then(done)
          })

          after((done) => {
            closeAndWipeAgent().then(done)
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, kinesisParams, key, metadata)
          })
        })

        describe('with configuration', () => {
          before((done) => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            AWS.config.update({ region: 'REGION' })
            epKinesis = new AWS.Endpoint('http://localhost:4566')
            kinesis = new AWS.Kinesis({ endpoint: epKinesis })

            agent.load('aws-sdk', {
              hooks: {
                request: (span, response) => {
                  span.addTags({
                    'aws.specialValue': 'foo',
                    ['aws.params' + key]: response.request.params[key]
                  })
                }
              }
            }).then(done)
          })

          after((done) => {
            closeAndWipeAgent().then(done)
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, kinesisParams, key, metadata, true)
          })
        })
      })

      describe('Lambda', () => {
        const lambdaInvokeParams = fixtures.lambda.invoke
        const operation = 'invoke'
        const serviceName = 'lambda'
        const klass = 'Lambda'
        const key = 'FunctionName'
        const metadata = 'resource.name'
        const getService = () => { return lambda }
        let epLambda
        let lambda

        describe('without configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epLambda = new AWS.Endpoint('http://localhost:4566')
            AWS.config.update({ region: 'REGION' })
            lambda = new AWS.Lambda({ endpoint: epLambda })
            agent.load('aws-sdk').then(done)
          })

          after(done => {
            closeAndWipeAgent().then(done)
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, sqsGetParams, key, metadata)
          })

          it('propagation should work', (done) => {
            let parentId
            let traceId
            agent.use(traces => {
              expect(traces[0][0].resource.startsWith('invoke')).to.equal(true)
              parentId = traces[0][0].span_id.toString()
              traceId = traces[0][0].trace_id.toString()
            })
            const { FunctionName } = lambdaInvokeParams
            lambda.invoke({
              Payload: '{}',
              FunctionName
            }, (err, data) => {
              if (err) {
                return done(err)
              }
              
              agent.use(traces => {
                expect(parentId).to.be.a('string')
                expect(traces[0][0].parent_id.toString()).to.equal(parentId)
                expect(traces[0][0].trace_id.toString()).to.equal(traceId)
              }).then(done, done)
            })
          })
        })

        describe('with configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epLambda = new AWS.Endpoint('http://localhost:4566')
            AWS.config.update({ region: 'REGION' })

            sqs = new AWS.SQS({ endpoint: epLambda })
            sqs.createQueue(sqsCreateParams, (err, res) => {
              if (err) return done(err)
              if (res.QueueUrl) {
                sqsGetParams.QueueUrl = res.QueueUrl
              }

              agent.load('aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                }
              }).then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSqs = new AWS.Endpoint('http://localhost:4566')
            sqs = new AWS.SQS({ endpoint: epSqs })

            sqs.deleteQueue(sqsGetParams, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, sqsGetParams, key, metadata, true)
          })
        })
      })

      describe('S3', () => {
        const s3Params = fixtures.s3.create
        const operation = 'listObjects'
        const serviceName = 's3'
        const klass = 'S3'
        const key = 'Bucket'
        const metadata = 's3.bucket_name'
        const getService = () => { return s3 }
        let epS3
        let s3

        describe('without configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4566')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })

            s3.createBucket({ Bucket: s3Params.Bucket }, () => {
              agent.load('aws-sdk').then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4566')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })
            s3.deleteBucket(s3Params, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, s3Params, key, metadata)
          })

          // Regression test for https://github.com/DataDog/dd-trace-js/issues/992
          it('upload should not be broken', (done) => {
            s3.upload({
              Bucket: s3Params.Bucket,
              Key: 'testupload',
              Body: 'some body'
            }, done)
          })
        })

        describe('with configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4566')
            s3 = new AWS.S3({ endpoint: epS3, s3ForcePathStyle: true })

            s3.createBucket({ Bucket: s3Params.Bucket }, () => {
              agent.load('aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                }
              }).then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epS3 = new AWS.Endpoint('http://localhost:4566')
            s3 = new AWS.S3({ apiVersion: '2016-03-01', endpoint: epS3, s3ForcePathStyle: true })
            s3.deleteBucket(s3Params, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, s3Params, key, metadata, true)
          })
        })
      })

      describe('SQS', () => {
        const sqsCreateParams = fixtures.sqs.create
        const sqsGetParams = fixtures.sqs.get
        const operation = 'receiveMessage'
        const serviceName = 'sqs'
        const klass = 'SQS'
        const key = 'QueueUrl'
        const metadata = 'sqs.queue_name'
        const getService = () => { return sqs }
        let epSqs
        let sqs

        describe('without configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSqs = new AWS.Endpoint('http://localhost:4566')
            AWS.config.update({ region: 'REGION' })

            sqs = new AWS.SQS({ endpoint: epSqs })
            sqs.createQueue(sqsCreateParams, (err, res) => {
              if (err) return done(err)
              if (res.QueueUrl) {
                sqsGetParams.QueueUrl = res.QueueUrl
              }

              agent.load('aws-sdk').then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSqs = new AWS.Endpoint('http://localhost:4566')
            sqs = new AWS.SQS({ endpoint: epSqs })

            sqs.deleteQueue(sqsGetParams, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, sqsGetParams, key, metadata)
          })

          it('propagation should work', (done) => {
            let parentId
            let traceId
            agent.use(traces => {
              expect(traces[0][0].resource.startsWith('sendMessage')).to.equal(true)
              parentId = traces[0][0].span_id.toString()
              traceId = traces[0][0].trace_id.toString()
            })
            const { QueueUrl } = sqsGetParams
            sqs.sendMessage({
              MessageBody: 'test body',
              QueueUrl
            }, (err, data) => {
              if (err) {
                return done(err)
              }
              sqs.receiveMessage({
                QueueUrl,
                MessageAttributeNames: ['.*']
              }, (err, data) => {
                if (err) {
                  return done(err)
                }
                agent.use(traces => {
                  expect(parentId).to.be.a('string')
                  expect(traces[0][0].parent_id.toString()).to.equal(parentId)
                  expect(traces[0][0].trace_id.toString()).to.equal(traceId)
                }).then(done, done)
              })
            })
          })
        })

        describe('with configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSqs = new AWS.Endpoint('http://localhost:4566')
            AWS.config.update({ region: 'REGION' })

            sqs = new AWS.SQS({ endpoint: epSqs })
            sqs.createQueue(sqsCreateParams, (err, res) => {
              if (err) return done(err)
              if (res.QueueUrl) {
                sqsGetParams.QueueUrl = res.QueueUrl
              }

              agent.load('aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                }
              }).then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSqs = new AWS.Endpoint('http://localhost:4566')
            sqs = new AWS.SQS({ endpoint: epSqs })

            sqs.deleteQueue(sqsGetParams, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, sqsGetParams, key, metadata, true)
          })
        })
      })

      describe('SNS', () => {
        const snsCreateParams = fixtures.sns.create
        const snsGetParams = fixtures.sns.get
        const operation = 'getTopicAttributes'
        const serviceName = 'sns'
        const klass = 'SNS'
        const key = 'TopicArn'
        const metadata = 'sns.topic_arn'
        const getService = () => { return sns }
        let epSns
        let sns
        let topicArn

        describe('without configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSns = new AWS.Endpoint('http://localhost:4566')

            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            sns = new AWS.SNS({ endpoint: epSns })

            sns.createTopic(snsCreateParams, (err, res) => {
              if (err) return done(err)
              if (res.TopicArn) {
                snsGetParams.TopicArn = res.TopicArn
              }

              agent.load('aws-sdk').then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSns = new AWS.Endpoint('http://localhost:4566')
            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            sns = new AWS.SNS({ endpoint: epSns })

            // cleanup topics
            sns.listTopics({}, (err, res) => {
              if (res && res.Topics && res.Topics.length > 0) {
                sns.deleteTopic(res.Topics[0], () => {
                  closeAndWipeAgent().then(done)
                })
              } else {
                closeAndWipeAgent().then(done)
              }
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, snsGetParams, key, metadata)

            it('should use the response data topicArn for resource and metadata when creating topic', (done) => {
              sns.createTopic({ Name: 'example_topic_two' }, (err, res) => {
                if (err) return done(err)

                topicArn = res.TopicArn

                agent.use(traces => {
                  expect(traces[0][0]).to.have.property('resource', `createTopic ${topicArn}`)
                  expect(traces[0][0]).to.have.property('name', 'aws.request')
                  expect(traces[0][0].service).to.include(serviceName)
                  expect(traces[0][0].meta).to.have.property('aws.service', klass)
                  expect(traces[0][0].meta).to.have.property('component', 'aws-sdk')
                  expect(traces[0][0].meta['aws.sns.topic_arn']).to.be.a('string')
                  expect(traces[0][0].meta['aws.region']).to.be.a('string')
                  expect(traces[0][0].meta).to.have.property('aws.operation', 'createTopic')
                }).then(done).catch(done)
              })
            })
          })
        })

        describe('with configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSns = new AWS.Endpoint('http://localhost:4566')

            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            sns = new AWS.SNS({ endpoint: epSns })

            sns.createTopic(snsCreateParams, (err, res) => {
              if (err) return done(err)
              if (res.TopicArn) {
                snsGetParams.TopicArn = res.TopicArn
              }

              agent.load('aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                }
              }).then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epSns = new AWS.Endpoint('http://localhost:4566')
            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            sns = new AWS.SNS({ endpoint: epSns })

            // cleanup topics
            sns.listTopics({}, (err, res) => {
              if (res && res.Topics && res.Topics.length > 0) {
                sns.deleteTopic({ TopicArn: topicArn }, () => {
                  closeAndWipeAgent().then(done)
                })
              } else {
                closeAndWipeAgent().then(done)
              }
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, snsGetParams, key, metadata, true)
          })
        })
      })

      describe('Cloudwatch Logs', () => {
        const cwCreateParams = fixtures.cloudwatchlogs.create
        const operation = 'describeLogStreams'
        const serviceName = 'cloudwatchlogs'
        const klass = 'CloudWatchLogs'
        const key = 'logGroupName'
        const metadata = 'cloudwatch.logs.log_group_name'
        const getService = () => { return cwLogs }
        let epCwLogs
        let cwLogs

        describe('without configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epCwLogs = new AWS.Endpoint('http://localhost:4566')

            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            cwLogs = new AWS.CloudWatchLogs({ endpoint: epCwLogs })

            cwLogs.createLogGroup(cwCreateParams, (err, res) => {
              if (err) return done(err)

              agent.load('aws-sdk').then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epCwLogs = new AWS.Endpoint('http://localhost:4566')
            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            cwLogs = new AWS.CloudWatchLogs({ endpoint: epCwLogs })

            // cleanup log groups
            cwLogs.deleteLogGroup(cwCreateParams, (err, res) => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, cwCreateParams, key, metadata)
          })
        })

        describe('with configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epCwLogs = new AWS.Endpoint('http://localhost:4566')

            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            cwLogs = new AWS.CloudWatchLogs({ endpoint: epCwLogs })

            cwLogs.createLogGroup(cwCreateParams, (err, res) => {
              if (err) return done(err)

              agent.load('aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                }
              }).then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epCwLogs = new AWS.Endpoint('http://localhost:4566')
            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            cwLogs = new AWS.CloudWatchLogs({ endpoint: epCwLogs })

            // cleanup log groups
            cwLogs.deleteLogGroup(cwCreateParams, (err, res) => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, cwCreateParams, key, metadata, true)
          })
        })
      })

      describe('Redshift', () => {
        const redshiftCreateParams = fixtures.redshift.create
        const redshiftGetParams = fixtures.redshift.get
        const operation = 'describeClusters'
        const serviceName = 'redshift'
        const klass = 'Redshift'
        const key = 'ClusterIdentifier'
        const metadata = 'redshift.cluster_identifier'
        const getService = () => { return redshift }
        let epRedshift
        let redshift

        describe('without configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epRedshift = new AWS.Endpoint('http://localhost:4566')

            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            redshift = new AWS.Redshift({ endpoint: epRedshift })

            redshift.createCluster(redshiftCreateParams, (err, res) => {
              if (err) return done(err)

              agent.load('aws-sdk').then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epRedshift = new AWS.Endpoint('http://localhost:4566')
            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            redshift = new AWS.Redshift({ endpoint: epRedshift })

            // cleanup clusters
            redshift.deleteCluster(redshiftGetParams, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, redshiftGetParams, key, metadata)
          })
        })

        describe('with configuration', () => {
          before(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epRedshift = new AWS.Endpoint('http://localhost:4566')

            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            redshift = new AWS.Redshift({ endpoint: epRedshift })

            redshift.createCluster(redshiftCreateParams, (err, res) => {
              if (err) return done(err)

              agent.load('aws-sdk', {
                hooks: {
                  request: (span, response) => {
                    span.addTags({
                      'aws.specialValue': 'foo',
                      ['aws.params' + key]: response.request.params[key]
                    })
                  }
                }
              }).then(done)
            })
          })

          after(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epRedshift = new AWS.Endpoint('http://localhost:4566')
            // region has to be a real region
            AWS.config.update({ region: 'us-east-1' })
            redshift = new AWS.Redshift({ endpoint: epRedshift })

            // cleanup clusters
            redshift.deleteCluster(redshiftGetParams, () => {
              closeAndWipeAgent().then(done)
            })
          })

          describe('instrumentation', () => {
            helpers.baseSpecs(semver, version, agent, getService, operation,
              serviceName, klass, redshiftGetParams, key, metadata, true)
          })
        })
      })

      describe('General Service', () => {
        // we do not instrument route53 at this time specifically
        // this is meant to demonstrate defaults for non instrumented service
        // if we do later add specific metadata for route53, need to update to a different service
        const operation = 'listHealthChecks'
        const serviceName = 'route53'
        const klass = 'Route53'
        let epRoute53
        let route53

        describe('without configuration', () => {
          beforeEach(done => {
            const AWS = require(`../../../versions/aws-sdk@${version}`).get()
            epRoute53 = new AWS.Endpoint('http://localhost:4566')
            AWS.config.update({ region: 'us-east-1' })
            route53 = new AWS.Route53({ endpoint: epRoute53 })
            agent.load(['aws-sdk', 'http']).then(done)
          })

          afterEach(done => {
            closeAndWipeAgent().then(done)
          })

          describe('instrumentation', () => {
            it('should instrument service methods with a callback', (done) => {
              route53[operation]({}, (err, response) => {
                if (err) return done(err)

                agent
                  .use(traces => {
                    const spans = sort(traces[0])
                    expect(spans[0]).to.have.property('resource', `${operation}`)
                    expect(spans[0]).to.have.property('name', 'aws.request')
                    expect(spans[0].service).to.include(serviceName)
                    expect(spans[0].meta).to.have.property('aws.service', klass)
                    expect(spans[0].meta).to.have.property('component', 'aws-sdk')
                    expect(spans[0].meta['aws.region']).to.be.a('string')
                    expect(spans[0].meta).to.have.property('aws.operation', operation)
                  }).then(done).catch(done)
              })
            })

            it('should instrument service methods without a callback', (done) => {
              agent
                .use(traces => {
                  const spans = sort(traces[0])
                  expect(spans[0]).to.have.property('resource', `${operation}`)
                  expect(spans[0]).to.have.property('name', 'aws.request')
                  expect(spans[0].service).to.include(serviceName)
                  expect(spans[0].meta).to.have.property('aws.service', klass)
                  expect(spans[0].meta).to.have.property('component', 'aws-sdk')
                  expect(spans[0].meta['aws.region']).to.be.a('string')
                  expect(spans[0].meta).to.have.property('aws.operation', operation)
                })
                .then(done)
                .catch(done)

              const route53Request = route53[operation]({})
              route53Request.send()
            })

            if (semver.intersects(version, '>=2.3.0')) {
              it('should instrument service methods using promise()', (done) => {
                function checkTraces () {
                  agent.use(traces => {
                    const spans = sort(traces[0])
                    expect(spans[0]).to.have.property('resource', `${operation}`)
                    expect(spans[0]).to.have.property('name', 'aws.request')
                    expect(spans[0].service).to.include(serviceName)
                    expect(spans[0].meta).to.have.property('aws.service', klass)
                    expect(spans[0].meta).to.have.property('component', 'aws-sdk')
                    expect(spans[0].meta['aws.region']).to.be.a('string')
                    expect(spans[0].meta).to.have.property('aws.operation', operation)
                  }).then(done).catch(done)
                }

                const route53Request = route53[operation]({}).promise()
                route53Request.then(checkTraces).catch(checkTraces)
              })
            }

            it('should mark error responses', (done) => {
              route53[operation]({
                'IllegalKey': 'IllegalValue'
              }, () => {
                agent.use(traces => {
                  const spans = sort(traces[0])
                  expect(spans[0]).to.have.property('resource', `${operation}`)
                  expect(spans[0]).to.have.property('name', 'aws.request')
                  expect(spans[0].service).to.include(serviceName)
                  expect(spans[0].meta).to.have.property('aws.service', klass)
                  expect(spans[0].meta).to.have.property('component', 'aws-sdk')
                  expect(spans[0].meta['aws.region']).to.be.a('string')
                  expect(spans[0].meta).to.have.property('aws.operation', operation)
                  expect(spans[0].meta['error.type']).to.be.a('string')
                  expect(spans[0].meta['error.msg']).to.be.a('string')
                  expect(spans[0].meta['error.stack']).to.be.a('string')
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
              agent.use(traces => {
                const spans = sort(traces[0])
                expect(spans[1].parent_id.toString()).to.equal(spans[0].span_id.toString())
                expect(spans.length).to.equal(2)
              }).then(done).catch(done)

              const tableRequest = route53[operation]({})
              tableRequest.send()
            })

            it('should bind callbacks to the correct active span', (done) => {
              let activeSpanName
              const parentName = 'parent'

              tracer.trace(parentName, () => {
                route53[operation]({}, () => {
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
})
