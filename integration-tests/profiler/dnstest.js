'use strict'

const dns = require('node:dns')

require('dd-trace').init().profilerStarted().then(() => {
  dns.lookupService('13.224.103.60', 80, () => {})
  dns.lookup('example.org', () => {})
  dns.lookup('example.com', () => {})
  dns.lookup('datadoghq.com', () => {})
  dns.resolve4('datadoghq.com', () => {})
  dns.lookup('dfslkgsjkrtgrdg.com', () => {})
})
