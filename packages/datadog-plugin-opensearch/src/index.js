'use strict'

const ElasticsearchPlugin = require('../../datadog-plugin-elasticsearch/src')

class OpenSearchPlugin extends ElasticsearchPlugin {
  static get name () {
    return 'opensearch'
  }
}

module.exports = OpenSearchPlugin
