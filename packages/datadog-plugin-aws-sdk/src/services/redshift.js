'use strict'

const BaseAwsSdkPlugin = require('../base')

class Redshift extends BaseAwsSdkPlugin {
  static get id () { return 'redshift' }

  generateTags (params, operation, response) {
    if (!params?.ClusterIdentifier) return {}

    return {
      'resource.name': `${operation} ${params.ClusterIdentifier}`,
      'aws.redshift.cluster_identifier': params.ClusterIdentifier,
      clusteridentifier: params.ClusterIdentifier
    }
  }
}

module.exports = Redshift
