'use strict'

const BaseAwsSdkPlugin = require('../base')

class CloudwatchLogs extends BaseAwsSdkPlugin {
  static get id () { return 'cloudwatchlogs' }

  generateTags (params, operation) {
    if (!params?.logGroupName) return {}

    return {
      'resource.name': `${operation} ${params.logGroupName}`,
      'aws.cloudwatch.logs.log_group_name': params.logGroupName,
      loggroupname: params.logGroupName
    }
  }
}

module.exports = CloudwatchLogs
