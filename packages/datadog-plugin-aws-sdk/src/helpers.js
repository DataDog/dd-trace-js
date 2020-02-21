'use strict'

const helpers = {
  wrapCallback (tracer, span, callback, parent, config, serviceName) {
    return function (err, response) {
      // "this" should refer to response object https://github.com/aws/aws-sdk-js/issues/781#issuecomment-156250427
      helpers.addResponseTags(span, this, serviceName, config)
      helpers.finish(span, err)

      if (typeof callback === 'function') {
        return tracer.scope().activate(parent, () => callback.apply(null, arguments))
      }
    }
  },

  finish (span, err) {
    if (err) {
      span.setTag('error', err)
      this.addRequestIdTag(span, err)
    }

    span.finish()
  },

  // TODO: split into easier to handle small functions
  addResponseTags (span, response, serviceName, config) {
    if (!span) return

    if (response.request) {
      this.addServicesTags(span, response, serviceName)
    }

    this.addRequestIdTag(span, response)
    this.addHttpResponseTags(span, response)
    config.hooks.request(span, response)
  },

  addServicesTags (span, response, serviceName) {
    if (!span) return

    const params = response.request.params
    const operation = response.request.operation

    if (operation && params) {
      switch (serviceName) {
        case 'dynamodb':
          this.addDynamoDbTags(span, params, operation)
          break

        case 'kinesis':
          this.addKinesisTags(span, params, operation)
          break

        case 's3':
          this.addS3Tags(span, params, operation)
          break

        case 'sqs':
          this.addSqsTags(span, params, operation)
          break

        case 'sns':
          this.addSnsTags(span, params, operation, response)
          break
      }
    } else {
      this.addDefaultTags(span, operation)
    }
  },

  addDefaultTags (span, operation) {
    // defaults
    span.addTags({
      'resource.name': operation || 'Amazon'
    })
  },

  addDynamoDbTags (span, params, operation) {
    // dynamoDB TableName
    if (params.TableName) {
      // also add span type to match serverless convention
      span.addTags({
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
          span.addTags({
            'resource.name': `${operation} ${tableName}`,
            'aws.dynamodb.table_name': tableName
          })
        }
      }
    }
    // TODO: DynamoDB.DocumentClient does batches on multiple tables
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchGet-property
    // it may be useful to have a different resource naming convention here to show all table names

    span.addTags({
      'span.type': 'dynamodb'
    })
  },

  addKinesisTags (span, params, operation) {
    // kenesis StreamName
    if (!params.StreamName) return

    span.addTags({
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName
    })
  },

  addS3Tags (span, params, operation) {
    // s3 Bucket
    if (!params.Bucket) return

    span.addTags({
      'resource.name': `${operation} ${params.Bucket}`,
      'aws.s3.bucket_name': params.Bucket
    })
  },

  addSqsTags (span, params, operation) {
    // sqs queue
    if (!params.QueueName && !params.QueueUrl) return

    span.addTags({
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl
    })
  },

  addSnsTags (span, params, operation, response) {
    // sns topic
    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return

    // SNS.createTopic is invoked with name but returns full arn in response data
    // which is used elsewhere to refer to topic
    span.addTags({
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
  },

  addHttpResponseTags (span, res) {
    if (!span) return

    // status code and content length to match what serverless captures
    if (res.httpResponse) {
      if (res.httpResponse.headers && res.httpResponse.headers['content-length']) {
        span.addTags({ 'http.content_length': res.httpResponse.headers['content-length'].toString() })
      }

      if (res.httpResponse.statusCode) {
        span.addTags({ 'http.status_code': res.httpResponse.statusCode.toString() })
      }
    }
  }
}

module.exports = helpers
