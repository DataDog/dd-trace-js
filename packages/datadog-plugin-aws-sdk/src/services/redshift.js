'use strict'

const BaseAwsSdkPlugin = require('../base')

class Redshift extends BaseAwsSdkPlugin {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.ClusterIdentifier) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.ClusterIdentifier}`,
      'aws.redshift.cluster_identifier': params.ClusterIdentifier
    })
  }
}

module.exports = Redshift
