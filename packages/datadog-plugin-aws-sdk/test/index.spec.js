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
        let epDynamo
        let ddb

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

        describe('without configuration', () => {
          const operationName = 'createTable'
          const service = 'DynamoDB'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${ddbParams.TableName}`)           
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.table.name']).to.be.a('string')

                // requestID will randomly not exist on resp headers for dynamoDB, it's unclear why it may be due to test env
                // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            ddb[operationName](ddbParams, () => {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${ddbParams.TableName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.table.name']).to.be.a('string')

                // this randomly doesn't exist on resp headers for dynamoDB, it's unclear why it may be due to test env
                // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const table_request = ddb[operationName](ddbParams)
            const response = table_request.send()
          })

          it('should instrument service methods using promise()', (done) => {
            const table_request =  ddb[operationName](ddbParams).promise()
            // const delete_request = ddb.deleteTable( {TableName: ddbParams.TableName} ).promise()

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('resource', `${operationName}_${ddbParams.TableName}`)
              expect(traces[0][0]).to.have.property('name', 'aws.http')
              expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
              expect(traces[0][0].meta['aws.table.name']).to.be.a('string')

              // this randomly doesn't exist on resp headers for dynamoDB, it's unclear why it may be due to test env
              // expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
            }).then(done).catch(done)
          })

          it('should collect table name metadata for batch operations', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `batchGetItem_${ddbParams.TableName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
                expect(traces[0][0].meta['aws.table.name']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const batch_item_request = ddb.batchGetItem(ddbBatchParams).promise()
            batch_item_request.then(checkTraces).catch(checkTraces) 
          })          
        })
      })

      describe('Kinesis', () => {
        const kinesis_params = fixtures.kinesis
        let ep_kinesis
        let kinesis

        beforeEach(() => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          AWS.config.update({region: 'REGION'})
          ep_kinesis = new AWS.Endpoint('http://localhost:4568')
          kinesis = new AWS.Kinesis({endpoint: ep_kinesis})
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = 'createStream'
          const service = 'Kinesis'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${kinesis_params.StreamName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          
          const ep_s3 = new AWS.Endpoint('http://localhost:4572')
          s3 = new AWS.S3({apiVersion: '2016-03-01', endpoint: ep_s3, s3ForcePathStyle: true})
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = 'createBucket'
          const service = 'S3'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${s3_params.Bucket}`)
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()          
          const ep_sqs = new AWS.Endpoint('http://localhost:4576')
          AWS.config.update({ region: 'REGION' })

          sqs = new AWS.SQS({ endpoint: ep_sqs })
          return agent.load(plugin, 'aws-sdk')
        })

        describe('without configuration', () => {
          const operationName = 'createQueue'
          const service = 'SQS'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${sqs_params.QueueName}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
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
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.queue.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const sqs_request = sqs[operationName](sqs_params).promise()
            sqs_request.then(checkTraces).catch(checkTraces)            
          })
        })
      })

      describe('SNS', () => {
        const sns_params = fixtures.sns
        let ep_sns
        let sns
        let topicArn
        let topicArnTwo

        beforeEach(() => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()          
          const ep_sns = new AWS.Endpoint('http://localhost:4575')
          
          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })

          sns = new AWS.SNS({ endpoint: ep_sns })

          return sns.createTopic(sns_params).promise().then( data => {
            topicArn = data.TopicArn
          }).catch( err => {
          }).finally( () => {
            agent.load(plugin, 'aws-sdk')
          })
        })

        afterEach(() => {
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()          
          const ep_sns = new AWS.Endpoint('http://localhost:4575')
          
          // region has to be a real region
          AWS.config.update({ region: 'us-east-1' })
          sns = new AWS.SNS({ endpoint: ep_sns })

          // cleanup topics
          return Promise.all([topicArn, topicArnTwo]
            .filter( arn => arn !== undefined )
            .map( arn => sns.deleteTopic({TopicArn: arn}).promise())
            ).catch()
        })        

        describe('without configuration', () => {
          const operationName = 'getTopicAttributes'
          const service = 'SNS'

          it('should instrument service methods with a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.topic.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)

            const topic_request = sns.getTopicAttributes({TopicArn: topicArn}, function(err_create, data_create) {})
          })

          it('should instrument service methods without a callback', (done) => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.topic.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              })
              .then(done)
              .catch(done)

            const sns_request = sns[operationName]({TopicArn: topicArn})
            const response = sns_request.send()
          })

          it('should instrument service methods using promise()', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${operationName}_${topicArn}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.topic.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)  
            }

            const sns_request = sns[operationName]({TopicArn: topicArn}).promise()
            sns_request.then(checkTraces).catch(checkTraces)
          })

          it('should use the response data topicArn for resource and metadata when creating topic', (done) => {
            function checkTraces() {
              agent.use(traces => {
                expect(traces[0][0]).to.have.property('resource', `createTopic_${topicArnTwo}`)
                expect(traces[0][0]).to.have.property('name', 'aws.http')
                expect(traces[0][0].meta).to.have.property('aws.service', `Amazon.${service}`)
                expect(traces[0][0].meta['aws.topic.name']).to.be.a('string')
                expect(traces[0][0].meta['aws.requestId']).to.be.a('string')
              }).then(done).catch(done)  
            }

            sns.createTopic({Name: 'example_topic_two'}).promise().then( data => {
              topicArnTwo = data.TopicArn
            }).catch( err => {
            }).finally(checkTraces)
          })
        })
      })
    })
  })
})
