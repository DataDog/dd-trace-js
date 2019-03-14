'use strict'

const prebuildify = require('prebuildify')
const abi = require('node-abi')

const opts = {
  targets: abi.supportedTargets.filter(target => target.runtime === 'node'),
  strip: false
}

const cb = err => {
  if (err) throw err
}

prebuildify(opts, cb)
