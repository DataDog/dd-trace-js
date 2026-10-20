'use strict'

const { lookup } = require('node:dns')
const { readFile } = require('fs')
const { request } = require('http')

module.exports = async (incoming, response) => {
  const [address, body] = await Promise.all([
    new Promise((resolve, reject) => {
      lookup('localhost', { family: 4 }, (error, address) => error ? reject(error) : resolve(address))
    }),
    new Promise((resolve, reject) => {
      // Avoid an implicit HTTP DNS lookup masking a missing span from the explicit lookup above.
      const outgoing = request(`http://127.0.0.1:${incoming.socket.localPort}/builtin-target?source=cjs`, result => {
        let body = ''
        result.setEncoding('utf8')
        result.on('data', chunk => { body += chunk })
        result.once('end', () => resolve(body))
        result.once('error', reject)
      })
      outgoing.once('error', reject)
      outgoing.end()
    }),
    new Promise((resolve, reject) => {
      readFile(process.argv[1], error => error ? reject(error) : resolve())
    }),
  ])
  response.json({ address, body })
}
