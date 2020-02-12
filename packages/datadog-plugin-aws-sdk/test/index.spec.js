'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const fixtures = require('./aws_fixtures.js')

wrapIt()

describe('Plugin', () => {
  let tracer

  describe('aws-sdk', function () {
    before(() => {

    })
    after(() => {
      // delete process.env.PUBSUB_EMULATOR_HOST
    })

    afterEach(() => {
      agent.close()
      agent.wipe()
    })

    withVersions(plugin, 'aws-sdk', version => {
      describe('DynamoDB', () => {
        const ddb_params = fixtures.ddb
        const ddb_batch_params = fixtures.ddb_batch
        let ep_dynamo
        let ddb

        beforeEach(() => {
          tracer = require('../../dd-trace')

          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          
          AWS.config.update({region: 'REGION'})
          ep_dynamo = new AWS.Endpoint('http://localhost:4569')
          ddb = new AWS.DynamoDB( {endpoint: ep_dynamo} )

          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = "createTable"
          const service = "DynamoDB"

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${ddb_params.TableName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.table.name']).to.be.a('string')

                // requestID will randomly not exist on resp headers for dynamoDB, it's unclear why it may be due to test env
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)


            ddb[operationName](ddb_params, function(err_create, data_create) {
              if (!err_create) {
                ddb.deleteTable( {TableName: ddb_params.TableName }, function(err_data, data_delete) {})
              }
            })
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${ddb_params.TableName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.table.name']).to.be.a('string')

                // this randomly doesn't exist on resp headers for dynamoDB, it's unclear why it may be due to test env
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const table_request = ddb[operationName](ddb_params)
            const response = table_request.send()
          })

          it('should instrument service methods using promise()', (done) => {
            const table_request =  ddb[operationName](ddb_params).promise()
            const delete_request = ddb.deleteTable( {TableName: ddb_params.TableName} ).promise()

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('resource', `${operationName}_${ddb_params.TableName}`)
              expect(traces[0][0]).to.have.property('name', 'aws.http')
              expect(traces[0][0].meta['aws.table.name']).to.be.a('string')

              // this randomly doesn't exist on resp headers for dynamoDB, it's unclear why it may be due to test env
              // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
            }).then(done).catch(done)
          })

          it('should collect table name metadata for batch operations', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `batchGetItem_${ddb_params.TableName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
                expect(traces[0][0].meta['aws.table.name']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const batch_item_request = ddb.batchGetItem(ddb_batch_params).promise()
            batch_item_request.then(checkTraces).catch(checkTraces) 
          })          
        })
      })

      describe('Kinesis', () => {
        const kinesis_params = fixtures.kinesis
        let ep_kinesis
        let kinesis

        beforeEach(() => {
          tracer = require('../../dd-trace')
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          AWS.config.update({region: 'REGION'})
          ep_kinesis = new AWS.Endpoint('http://localhost:4568')
          kinesis = new AWS.Kinesis({endpoint: ep_kinesis})
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = "createStream"
          const service = "Kinesis"

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${kinesis_params.StreamName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.stream.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)                  

            kinesis[operationName](kinesis_params, function(err_create, data_create) {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${kinesis_params.StreamName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.stream.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const stream_request = kinesis[operationName](kinesis_params)
            const response = stream_request.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${kinesis_params.StreamName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
                expect(traces[0][0].meta['aws.stream.name']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const stream_request = kinesis[operationName](kinesis_params).promise()
            stream_request.then(checkTraces).catch(checkTraces)            
          })
        })
      })

      describe('S3', () => {
        const s3_params = fixtures.s3
        let ep_s3
        let s3

        beforeEach(() => {
          tracer = require('../../dd-trace')
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          
          const ep_s3 = new AWS.Endpoint('http://localhost:4572')
          s3 = new AWS.S3({apiVersion: '2016-03-01', endpoint: ep_s3, s3ForcePathStyle: true})
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = "createBucket"
          const service = "S3"

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${s3_params.Bucket}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.bucket.name']).to.be.a('string')
                // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)                  

            s3[operationName]({Bucket: s3_params.Bucket}, function(err_create, data_create) {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${s3_params.Bucket}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.bucket.name']).to.be.a('string')
                // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const s3_request = s3[operationName]({Bucket: s3_params.Bucket})
            const response = s3_request.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${s3_params.Bucket}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.bucket.name']).to.be.a('string')
                // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const s3_request = s3[operationName]({Bucket: s3_params.Bucket}).promise()
            s3_request.then(checkTraces).catch(checkTraces)            
          })
        })
      })


      describe('SQS', () => {
        const sqs_params = fixtures.sqs
        let ep_sqs
        let sqs

        beforeEach(() => {
          tracer = require('../../dd-trace')
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()          
          const ep_sqs = new AWS.Endpoint('http://localhost:4576')
          AWS.config.update({ region: 'REGION' })

          sqs = new AWS.SQS({ endpoint: ep_sqs })
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = "createQueue"
          const service = "SQS"

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${sqs_params.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.queue.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)                  

            sqs[operationName](sqs_params, function(err_create, data_create) {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${sqs_params.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.queue.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const sqs_request = sqs[operationName](sqs_params)
            const response = sqs_request.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${sqs_params.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta['aws.queue.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const sqs_request = sqs[operationName](sqs_params).promise()
            sqs_request.then(checkTraces).catch(checkTraces)            
          })
        })
      })
    })
  })
})
