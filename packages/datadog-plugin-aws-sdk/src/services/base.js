'use strict'

class BaseService {
  addTags (span, params, operation, response) {
    const tags = Object.assign({
      'aws.response.request_id': response.requestId,
      'resource.name': operation
    }, this._addServiceTags(params, operation, response))

    span.addTags(tags)
  }

  _addServiceTags () {
    return {}
  }
}

module.exports = BaseService
