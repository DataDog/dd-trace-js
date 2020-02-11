const awsHelpers = {
  wrapCallback (tracer, span, done, parent) {
    return function (err, response) {
      // "this" should refer to response object https://github.com/aws/aws-sdk-js/issues/781#issuecomment-156250427
      awsHelpers.addAdditionalTags(span, this, response)
      awsHelpers.finish(span, err)

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
        span.addTags({ 'aws.requestId': err.requestId })
      }
    }

    span.finish()
  },

  addAdditionalTags (span, context, extra) {
    if (span) {
      if (context.requestId) {
        span.addTags({ 'aws.requestId': context.requestId })
      }
      if (context.httpRequest && context.httpRequest.endpoint) {
        span.addTags({ 'aws.url': context.httpRequest.endpoint.href })
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
        tags['resource.name'] = `${operation}_${params.TableName}`
        tags['aws.table.name'] = params.TableName
      }

      // kenesis StreamName
      if (params.StreamName) {
        tags['resource.name'] = `${operation}_${params.StreamName}`
        tags['aws.stream.name'] = params.StreamName
      }

      // s3 Bucket
      if (params.Bucket) {
        tags['resource.name'] = `${operation}_${params.Bucket}`
        tags['aws.bucket.name'] = params.Bucket
      }
    }

    if (!tags['resource.name']) {
      // default
      tags['resource.name'] = operation || 'Amazon'
    }

    span.addTags(tags)
  }
}

module.exports = awsHelpers
