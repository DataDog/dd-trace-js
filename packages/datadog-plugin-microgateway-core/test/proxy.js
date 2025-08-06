'use strict'

const http = require('http')
const net = require('net')
const tls = require('tls')
const url = require('url')
const util = require('util')

const axios = require('axios')

module.exports = http.createServer((req, res) => {
  axios({
    url: req.url,
    method: req.method,
    headers: req.headers,
    responseType: 'stream',
    data: req
  }).then(r => r.data.pipe(res))
}).on('connect', (req, cltSocket, head) => {
  let proto, netLib
  if (req.url.indexOf('443') > -1) {
    proto = 'https'
    netLib = tls
  } else {
    proto = 'http'
    netLib = net
  }

  const connectionCb = () => {
    cltSocket.write([
      'HTTP/1.1 200 Connection Established\r\n',
      'Proxy-agent: Node.js-Proxy\r\n',
      '\r\n'
    ].join(''))

    targetConnection.write(head)
    targetConnection.pipe(cltSocket)
    cltSocket.pipe(targetConnection)
  }

  // eslint-disable-next-line n/no-deprecated-api
  const targetUrl = url.parse(util.format('%s://%s', proto, req.url))

  let targetConnection

  try {
    if (proto === 'http') {
      targetConnection = netLib.connect(targetUrl.port, targetUrl.hostname, connectionCb)
    } else {
      if (targetUrl.hostname === 'localhost') {
        targetConnection = netLib.connect({}, targetUrl.port, targetUrl.hostname, connectionCb)
      } else {
        targetConnection = netLib.connect(targetUrl.port, targetUrl.hostname, connectionCb)
      }
    }
  } catch (e) {
    console.log(e) // eslint-disable-line no-console
  }
})
