'use strict'

const helpers = {
  finish (span, err) {
    if (err) {
      span.setTag('error', err)
      this.addRequestIdTag(span, err)
    }

    span.finish()
  },

  addResponseTags (span, response, serviceName, config) {
    if (!span) return

    if (response.request) {
      this.addServicesTags(span, response, serviceName)
    }

    this.addRequestIdTag(span, response)
    config.hooks.request(span, response)
  },

  addServicesTags (span, response, serviceName) {
    if (!span) return

    const tags = {}
    const params = response.request.params
    const operation = response.request.operation

    if (operation && params) {
      switch (serviceName) {
        case 'dynamodb':
          this.addDynamoDbTags(params, operation, tags)
          break

        case 'kinesis':
          this.addKinesisTags(params, operation, tags)
          break

        case 's3':
          this.addS3Tags(params, operation, tags)
          break

        case 'sqs':
          this.addSqsTags(params, operation, tags)
          break

        case 'sns':
          this.addSnsTags(params, operation, response, tags)
          break
      }
    }

    this.addDefaultTags(operation, tags)
    span.addTags(tags)
  },

  addDefaultTags (operation, tags) {
    // defaults
    if (tags['resource.name']) return

    Object.assign(tags, {
      'resource.name': operation || 'Amazon'
    })
  },

  addDynamoDbTags (params, operation, tags) {
    // dynamoDB TableName
    if (params.TableName) {
      Object.assign(tags, {
        'resource.name': `${operation} ${params.TableName}`,
        'aws.dynamodb.table_name': params.TableName
      })
    }

    // batch operations have different format, collect table name for batch
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#batchGetItem-property`
    // dynamoDB batch TableName
    if (params.RequestItems) {
      if (typeof params.RequestItems === 'object') {
        if (Object.keys(params.RequestItems).length === 1) {
          const tableName = Object.keys(params.RequestItems)[0]

          // also add span type to match serverless convention
          Object.assign(tags, {
            'resource.name': `${operation} ${tableName}`,
            'aws.dynamodb.table_name': tableName
          })
        }
      }
    }

    // TODO: DynamoDB.DocumentClient does batches on multiple tables
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchGet-property
    // it may be useful to have a different resource naming convention here to show all table names

    // also add span type to match serverless convention
    Object.assign(tags, {
      'span.type': 'dynamodb'
    })
  },

  addKinesisTags (params, operation, tags) {
    // kenesis StreamName
    if (!params.StreamName) return

    Object.assign(tags, {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName
    })
  },

  addS3Tags (params, operation, tags) {
    // s3 Bucket
    if (!params.Bucket) return

    Object.assign(tags, {
      'resource.name': `${operation} ${params.Bucket}`,
      'aws.s3.bucket_name': params.Bucket
    })
  },

  addSqsTags (params, operation, tags) {
    // sqs queue
    if (!params.QueueName && !params.QueueUrl) return

    Object.assign(tags, {
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl
    })
  },

  addSnsTags (params, operation, response, tags) {
    // sns topic
    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return

    // SNS.createTopic is invoked with name but returns full arn in response data
    // which is used elsewhere to refer to topic
    Object.assign(tags, {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': params.TopicArn || response.data.TopicArn
    })

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  },

  addRequestIdTag (span, res) {
    if (!span) return

    if (res.requestId) {
      span.addTags({ 'aws.response.request_id': res.requestId })
    }
  }
}

module.exports = helpers
