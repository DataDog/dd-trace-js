'use strict'

const Base = require('./base')

class CloudwatchLogs extends Base {
  _addServiceTags (params, operation, response) {
    const tags = {}

    if (!params || !params.logGroupName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.logGroupName}`,
      'aws.cloudwatch.logs.log_group_name': params.logGroupName
    })
  }
}

module.exports = CloudwatchLogs
