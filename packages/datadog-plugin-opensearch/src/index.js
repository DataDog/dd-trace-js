'use strict'

const ElasticsearchPlugin = require('../../datadog-plugin-elasticsearch/src')

class OpenSearchPlugin extends ElasticsearchPlugin {
  static id = 'opensearch'
}

module.exports = OpenSearchPlugin
