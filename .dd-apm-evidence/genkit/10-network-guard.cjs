'use strict'

const dns = require('node:dns')
const net = require('node:net')
const tls = require('node:tls')

let attemptedNetworkCalls = 0

function blockNetwork (operation) {
  return function blockedNetworkCall () {
    attemptedNetworkCalls++
    throw new Error(`Stage 10 network guard blocked ${operation}`)
  }
}

net.Socket.prototype.connect = blockNetwork('net.Socket.connect')
net.connect = blockNetwork('net.connect')
net.createConnection = blockNetwork('net.createConnection')
tls.connect = blockNetwork('tls.connect')
dns.lookup = blockNetwork('dns.lookup')
dns.resolve = blockNetwork('dns.resolve')
globalThis.fetch = blockNetwork('fetch')

process.once('exit', () => {
  process.stderr.write(`stage-10-network-attempts=${attemptedNetworkCalls}\n`)
})
