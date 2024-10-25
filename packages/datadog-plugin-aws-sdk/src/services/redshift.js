'use strict'

const BaseAwsSdkPlugin = require('../base')

class Redshift extends BaseAwsSdkPlugin {
  static get id () { return 'redshift' }

  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.ClusterIdentifier) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.ClusterIdentifier}`,
      'aws.redshift.cluster_identifier': params.ClusterIdentifier,
      clusteridentifier: params.ClusterIdentifier
    })
  }
}

module.exports = Redshift
