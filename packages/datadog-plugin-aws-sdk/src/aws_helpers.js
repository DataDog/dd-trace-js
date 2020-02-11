const helpers = {
  wrapCallback (tracer, span, done, parent, context) {
    return function (err, data) {
      this.addAdditionalTags(span, context)
      this.finish(span, err)

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
    }

    span.finish()
  },

  addAdditionalTags(span, context) {
    if (span) {
      if (context.requestId) {
        span.addTags('aws.requestId', context.requestId)
      }

      //dynamoDB TableName
      if (context.params && context.params.TableName) {
        span.addTags('aws.table.name', context.params.TableName)
      }

      if (context.httpRequest && context.httpRequest.endpoint) {
       span.addTags('aws.url', context.httpRequest.endpoint.href) 
      }

    }
  },

  // names are inconsistently prefixed with AWS or Amazon
  // standarize to Amazon.SQS/Amazon.S3/Amazon.DynamoDB etc
  normalizeServiceName(context) {
    const prefix = 'Amazon'
    const invalidPrefix = 'AWS'

    if (context.api && context.api.abbreviation) {
      let serviceName = context.api.abbreviation

      serviceName = serviceName.trim().replace(/\s/g, '')

      if (serviceName.startsWith(prefix)) {
        return `${serviceName.slice(0,prefix.length)}.${serviceName.slice(prefix.length)}`
      } else if (serviceName.startsWith(invalidPrefix)) {
        return `${prefix}.${serviceName.slice(invalidPrefix.length)}`
      } else {
        return `${prefix}.${serviceName}`
      }
    } else {
      return prefix
    }
  }
}

module.exports = helpers