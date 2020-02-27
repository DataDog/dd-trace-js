'use strict'

const Base = require('./base')

class Redshift extends Base {
  _addServiceTags (params, operation, response) {
    const tags = {}

    // redshift cluster name
    if (!params || !params.ClusterIdentifier) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.ClusterIdentifier}`,
      'aws.redshift.cluster_identifier': params.ClusterIdentifier
    })
  }
}

module.exports = Redshift
