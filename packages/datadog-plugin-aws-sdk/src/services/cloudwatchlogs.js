'use strict'

const BaseAwsSdkPlugin = require('../base')

class CloudwatchLogs extends BaseAwsSdkPlugin {
  generateTags (params, operation) {
    const tags = {}

    if (!params || !params.logGroupName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.logGroupName}`,
      'aws.cloudwatch.logs.log_group_name': params.logGroupName
    })
  }
}

module.exports = CloudwatchLogs
