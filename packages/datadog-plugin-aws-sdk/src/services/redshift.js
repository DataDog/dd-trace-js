'use strict'

const BaseService = require('./base')

class RedshiftService extends BaseService {
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

module.exports = RedshiftService
