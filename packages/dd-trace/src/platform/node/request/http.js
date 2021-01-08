'use strict'

const http = require('http')
const https = require('https')
const agents = require('../agents')

function requestHttp (options, callback) {
  const platform = this

  options = Object.assign({
    headers: {},
    data: [],
    timeout: 2000
  }, options)

  const data = [].concat(options.data)
  const isSecure = options.protocol === 'https:'
  const { httpAgent, httpsAgent } = agents(platform._config)
  const client = isSecure ? https : http
  const agent = isSecure ? httpsAgent : httpAgent

  options.agent = agent
  options.headers['Content-Length'] = byteLength(data)

  const req = client.request(options, res => {
    let data = ''

    res.setTimeout(options.timeout)

    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode <= 299) {
        callback(null, data, res.statusCode)
      } else {
        const error = new Error(`Error from the agent: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`)
        error.status = res.statusCode

        callback(error, null, res.statusCode)
      }
    })
  })

  req.setTimeout(options.timeout, req.abort)
  req.on('error', e => callback(new Error(`Network error trying to reach the agent: ${e.message}`)))

  data.forEach(buffer => req.write(buffer))

  req.end()
}

function byteLength (data) {
  let len = 0
  for (const item of data) {
    len += item.length
  }
  return len
}

module.exports = requestHttp
