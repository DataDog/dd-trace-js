'use strict'

const ElasticsearchPlugin = require('../../datadog-plugin-elasticsearch/src')

class OpenSearchPlugin extends ElasticsearchPlugin {
  static get id () {
    return 'opensearch'
  }

  startSpan (...args) {
    super.startSpan(...args)
  }
}

module.exports = OpenSearchPlugin
