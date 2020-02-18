'use strict'

const awsHelpers = {
  wrapCallback (tracer, span, callback, parent, config) {
    return function (err, response) {
      // "this" should refer to response object https://github.com/aws/aws-sdk-js/issues/781#issuecomment-156250427
      awsHelpers.addAwsResponseTags(span, this)

      config.hooks.addCustomTags(span, this.request.params)
      awsHelpers.finish(span, err)

      if (typeof callback === 'function') {
        return tracer.scope().activate(parent, () => callback.apply(null, arguments))
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

  addAwsRequestTags (span, request, operation, params, serviceName) {
    if (span) {
      if (request && request.httpRequest && context.request.httpRequest.endpoint) {
        span.addTags({ 'aws.url': request.httpRequest.endpoint.href })
      }

      // sync with serverless on how to normalize to fit existing conventions
      // <operation>_<specialityvalue>
      this.addAwsServiceTags(span,
        operation,
        params,
        serviceName
      )
    }
  },

  addAwsResponseTags (span, response) {
    if (span) {
      if (response.requestId) {
        span.addTags({ 'aws.request_id': response.requestId })
      }

      // status code and content length to match what serverless captures
      if (response.httpResponse) {
        if (response.httpResponse.headers && response.httpResponse.headers['content-length']) {
          span.addTags({ 'http.content_length': response.httpResponse.headers['content-length'].toString() })
        }

        if (response.httpResponse.statusCode) {
          span.addTags({ 'http.status_code': response.httpResponse.statusCode.toString() })
        }
      }

      // SNS.createTopic is invoked with name but returns full arn in response data
      // which is used elsewhere to refer to topic
      if (response.data && response.data.TopicArn && response.request.operation) {
        span.addTags({ 'aws.sns.topic_arn': response.data.TopicArn })
        span.addTags({ 'resource.name': `${response.request.operation} ${response.data.TopicArn}` })
      }

      // TODO: should arn be sanitized or quantized in some way here,
      // for example if it contains a phone number?
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

  addAwsServiceTags (span, operation, params, serviceName) {
    const tags = {}
    // TODO: move to case statement
    if (operation && params) {
      switch (serviceName) {
        case 'Amazon.DynamoDB':
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
          // it may be useful to have a different resource naming convention here to show all table names
          break

        case 'Amazon.Kinesis':
          // kenesis StreamName
          if (params.StreamName) {
            tags['resource.name'] = `${operation} ${params.StreamName}`
            tags['aws.kinesis.stream_name'] = params.StreamName
          }

          break

        case 'Amazon.S3':
          // s3 Bucket
          if (params.Bucket) {
            tags['resource.name'] = `${operation} ${params.Bucket}`
            tags['aws.s3.bucket_name'] = params.Bucket
          }

          break

        case 'Amazon.SQS':
          // sqs queue
          if (params.QueueName) {
            tags['resource.name'] = `${operation} ${params.QueueName}`
            tags['aws.sqs.queue_name'] = params.QueueName
          }

          break

        case 'Amazon.SNS':
          // sns topic
          if (params.TopicArn) {
            tags['resource.name'] = `${operation} ${params.TopicArn}`
            tags['aws.sns.topic_arn'] = params.TopicArn
          }

          // TODO: should arn be sanitized or quantized in some way here,
          // for example if it contains a phone number?

          break
      }

      // defaults
      if (!tags['resource.name']) {
        tags['resource.name'] = operation || 'Amazon'
      }

      if (!tags['span.type']) {
        tags['span.type'] = 'http'
      }
    }

    span.addTags(tags)
  }
}

module.exports = awsHelpers
