'use strict'

const redshift = {}

redshift.create = {
  ClusterIdentifier: 'example_redshift_cluster',
  MasterUserPassword: 'example_user_password',
  MasterUsername: 'example_username',
  NodeType: 'ds2.large'
}

redshift.get = {
  ClusterIdentifier: 'example_redshift_cluster'
}

module.exports = redshift
