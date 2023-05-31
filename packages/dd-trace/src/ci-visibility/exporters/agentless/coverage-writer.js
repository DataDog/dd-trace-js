'use strict'
const request = require('../../../exporters/common/request')
const log = require('../../../log')
const { safeJSONStringify } = require('../../../exporters/common/util')

const { CoverageCIVisibilityEncoder } = require('../../../encode/coverage-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')

class Writer extends BaseWriter {
  constructor ({ url, evpProxyPrefix = '' }) {
    super(...arguments)
    this._url = url
    this._encoder = new CoverageCIVisibilityEncoder(this)
    this._evpProxyPrefix = evpProxyPrefix
  }

  _sendPayload (form, _, done) {
    const options = {
      path: '/api/v2/citestcov',
      method: 'POST',
      headers: {
        'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
        ...form.getHeaders()
      },
      timeout: 15000,
      url: this._url
    }

    if (this._evpProxyPrefix) {
      options.path = `${this._evpProxyPrefix}/api/v2/citestcov`
      delete options.headers['dd-api-key']
      options.headers['X-Datadog-EVP-Subdomain'] = 'citestcov-intake'
    }

    log.debug(() => `Request to the intake: ${safeJSONStringify(options)}`)

    request(form, options, (err, res) => {
      if (err) {
        log.error(err)
        done()
        return
      }
      log.debug(`Response from the intake: ${res}`)
      done()
    })
  }
}

module.exports = Writer
