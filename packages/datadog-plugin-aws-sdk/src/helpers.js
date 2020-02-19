'use strict'

const helpers = {
  wrapCallback (tracer, span, callback, parent, config) {
    return function (err, response) {
      // "this" should refer to response object https://github.com/aws/aws-sdk-js/issues/781#issuecomment-156250427
      helpers.addResponseTags(span, this)
      config.hooks.http(span, this)
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

  addRequestTags (span, request, operation, params, serviceName) {
    if (!span) return

    if (request && request.httpRequest && context.request.httpRequest.endpoint) {
      span.addTags({ 'aws.url': request.httpRequest.endpoint.href })
    }

    // sync with serverless on how to normalize to fit existing conventions
    // <operation>_<specialityvalue>
    this.addServiceTags(span,
      operation,
      params,
      serviceName
    )
  },

  // TODO: split into easier to handle small functions
  addResponseTags (span, response) {
    if (!span) return

    this.addRequestIdTag(span, response)
    this.addHttpResponseTags(span, response)
    this.addSnsResponseTags(span, response)
  },

  // TODO: split into easier to handle small functions
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

  addServiceTags (span, operation, params, serviceName) {
    if (operation && params) {
      switch (serviceName) {
        case 'Amazon.DynamoDB':
          this.addDynamoDbTags(span, params, operation)
          break

        case 'Amazon.Kinesis':
          this.addKinesisTags(span, params, operation)
          break

        case 'Amazon.S3':
          this.addS3Tags(span, params, operation)
          break

        case 'Amazon.SQS':
          this.addSqsTags(span, params, operation)
          break

        case 'Amazon.SNS':
          this.addSnsTags(span, params, operation)
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

  addSnsTags (span, params, operation) {
    // sns topic
    if (!params.TopicArn) return
    span.addTags({
      'resource.name': `${operation} ${params.TopicArn}`,
      'aws.sns.topic_arn': params.TopicArn
    })

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  },

  addRequestIdTag (span, res) {
    if (!span) return

    if (res.requestId) {
      span.addTags({ 'aws.request_id': res.requestId })
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
  },

  addSnsResponseTags (span, res) {
    // SNS.createTopic is invoked with name but returns full arn in response data
    // which is used elsewhere to refer to topic
    if (res.data && res.data.TopicArn && res.request.operation) {
      span.addTags({ 'aws.sns.topic_arn': res.data.TopicArn })
      span.addTags({ 'resource.name': `${res.request.operation} ${res.data.TopicArn}` })
    }

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }
}

module.exports = helpers
