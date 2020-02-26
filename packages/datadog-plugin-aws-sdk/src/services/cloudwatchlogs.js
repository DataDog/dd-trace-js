'use strict'

const BaseService = require('./base')

class CloudwatchLogsService extends BaseService {
  _addServiceTags (params, operation, response) {
    const tags = {}

    // cloudwatach log group name
    if (!params || !params.logGroupName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.logGroupName}`,
      'aws.cloudwatch_logs.log_group_name': params.logGroupName
    })
  }
}

module.exports = CloudwatchLogsService
