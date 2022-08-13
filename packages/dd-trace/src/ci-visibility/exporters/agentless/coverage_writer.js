const { CIVisibilityCoverageEncoder } = require('../../../encode/ci-visibility-coverage')
const https = require('https')
const log = require('../../../log')

class Writer {
  constructor ({ url }) {
    this._url = url
    this._encoder = new CIVisibilityCoverageEncoder()
  }

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (count > 0) {
      const form = this._encoder.makePayload()

      this._sendPayload(form, count, done)
    } else {
      done()
    }
  }

  append ({ span, coverage }) {
    this._encoder.append({ span, coverage })
  }

  _sendPayload (form, _, done) {
    makeRequest(form, this._url, (err, res) => {
      if (err) {
        log.error(err)
        done()
        return
      }
      done()
    })
  }
}

function makeRequest (form, url, cb) {
  const options = {
    path: '/api/v2/citestcov',
    method: 'POST',
    headers: {
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
      ...form.getHeaders()
    },
    timeout: 15000
  }

  options.protocol = url.protocol
  options.hostname = url.hostname
  options.port = url.port

  const request = https.request(options, res => {
    res.on('data', () => {})
    res.on('end', () => {
      if (res.statusCode === 202) {
        cb(null)
      } else {
        const error = new Error(`Error uploading coverage: ${res.statusCode} ${res.statusMessage}`)
        error.status = res.statusCode
        cb(error)
      }
    })
  })

  request.on('error', (err) => {
    cb(err)
  })

  form.pipe(request)
}

module.exports = Writer
