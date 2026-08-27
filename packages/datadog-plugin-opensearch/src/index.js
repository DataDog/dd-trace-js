'use strict'

const ElasticsearchPlugin = require('../../datadog-plugin-elasticsearch/src')
const {
  configuredIntegrationService,
  configuredService,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'opensearch.query',
    serviceName: configuredIntegrationService('opensearch'),
    serviceSource: storageServiceSource('opensearch'),
  },
  v1: {
    operationName: () => 'opensearch.query',
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
}

class OpenSearchPlugin extends ElasticsearchPlugin {
  static id = 'opensearch'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }
}

module.exports = OpenSearchPlugin
