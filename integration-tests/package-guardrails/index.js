'use strict'

/* eslint-disable no-console */

try {
  const P = require('bluebird')

  const isWrapped = P.prototype._then.toString().includes('AsyncResource')

  console.log(isWrapped)
} catch (e) {
  const fastify = require('fastify')

  console.log(fastify.toString().startsWith('function shim'))
}
