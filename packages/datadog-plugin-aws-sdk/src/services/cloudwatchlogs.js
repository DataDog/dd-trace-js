'use strict'

const BaseAwsSdkPlugin = require('../base')

class CloudwatchLogs extends BaseAwsSdkPlugin {
  static get id () { return 'cloudwatchlogs' }

  generateTags (params, operation) {
    const tags = {}

    if (!params || !params.logGroupName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.logGroupName}`,
      'loggroupname': params.logGroupName
    })
  }
}

module.exports = CloudwatchLogs
