'use strict'

const awsHelpers = {
  wrapCallback (tracer, span, done, parent, config) {
    return function (err, response) {
      // "this" should refer to response object https://github.com/aws/aws-sdk-js/issues/781#issuecomment-156250427
      awsHelpers.addAdditionalTags(span, this)
      config.hooks.addTags(span, this.params, this.data)
      awsHelpers.finish(span, err, config)

      if (typeof done === 'function') {
        tracer.scope().activate(parent, () => {
          done.apply(null, arguments)
        })
      }
    }
  },

  finish (span, err) {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })

      if (err.requestId) {
        span.addTags({ 'aws.request_id': err.requestId })
      }
    }

    span.finish()
  },

  addAdditionalTags (span, context) {
    if (span) {
      if (context.requestId) {
        span.addTags({ 'aws.request_id': context.requestId })
      }

      if (context.request && context.request.httpRequest && context.request.httpRequest.endpoint) {
        span.addTags({ 'aws.url': context.request.httpRequest.endpoint.href })
      }

      // status code and content length to match what serverless captures
      if (context.httpResponse) {
        if (context.httpResponse.headers && context.httpResponse.headers['content-length']) {
          span.addTags({ 'http.content_length': context.httpResponse.headers['content-length'].toString() })
        }

        if (context.httpResponse.statusCode) {
          span.addTags({ 'http.status_code': context.httpResponse.statusCode.toString() })
        }
      }

      // SNS.createTopic is invoked with name but returns full arn in response data
      // which is used elsewhere to refer to topic
      if (context.data && context.data.TopicArn && context.request && context.request.operation) {
        span.addTags({ 'aws.sns.topic_arn': context.data.TopicArn })
        span.addTags({ 'resource.name': `${context.request.operation} ${context.data.TopicArn}` })
      }
    }
  },

  // names are inconsistently prefixed with AWS or Amazon
  // standarize to Amazon.SQS/Amazon.S3/Amazon.DynamoDB etc
  normalizeServiceName (context) {
    const prefix = 'Amazon'
    const invalidPrefix = 'AWS'

    if (context.api && context.api.abbreviation) {
      let serviceName = context.api.abbreviation

      serviceName = serviceName.trim().replace(/\s/g, '')

      if (serviceName.startsWith(prefix)) {
        return `${serviceName.slice(0, prefix.length)}.${serviceName.slice(prefix.length)}`
      } else if (serviceName.startsWith(invalidPrefix)) {
        return `${prefix}.${serviceName.slice(invalidPrefix.length)}`
      } else {
        return `${prefix}.${serviceName}`
      }
    } else {
      return prefix
    }
  },

  addResourceAndSpecialtyTags (span, operation, params) {
    const tags = {}
    // TODO: move to case statement
    if (operation && params) {
      // dynamoDB TableName
      if (params.TableName) {
        tags['resource.name'] = `${operation} ${params.TableName}`
        tags['aws.dynamodb.table_name'] = params.TableName
        // match serverless convention
        tags['span.type'] = 'dynamodb'
      }

      // batch operations have different format, collect table name for batch
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#batchGetItem-property`
      // dynamoDB batch TableName
      if (params.RequestItems) {
        if (typeof params.RequestItems === 'object') {
          if (Object.keys(params.RequestItems).length === 1) {
            const tableName = Object.keys(params.RequestItems)[0]

            tags['resource.name'] = `${operation} ${tableName}`
            tags['aws.dynamodb.table_name'] = tableName
            // match serverless convention
            tags['span.type'] = 'dynamodb'
          }
        }
      }

      // TODO: DynamoDB.DocumentClient does batches on multiple tables
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchGet-property
      // Delegates to single table batch operation, but it may be useful to create a parent span here

      // kenesis StreamName
      if (params.StreamName) {
        tags['resource.name'] = `${operation} ${params.StreamName}`
        tags['aws.kinesis.stream_name'] = params.StreamName
      }

      // s3 Bucket
      if (params.Bucket) {
        tags['resource.name'] = `${operation} ${params.Bucket}`
        tags['aws.s3.bucket_name'] = params.Bucket
      }

      // sqs queue
      if (params.QueueName) {
        tags['resource.name'] = `${operation} ${params.QueueName}`
        tags['aws.sqs.queue_name'] = params.QueueName
      }

      // sns topic
      if (params.TopicArn) {
        tags['resource.name'] = `${operation} ${params.TopicArn}`
        tags['aws.sns.topic_arn'] = params.TopicArn
      }
    }

    // defaults
    if (!tags['resource.name']) {
      tags['resource.name'] = operation || 'Amazon'
    }

    if (!tags['span.type']) {
      tags['span.type'] = 'http'
    }

    span.addTags(tags)
  }
}

module.exports = awsHelpers
