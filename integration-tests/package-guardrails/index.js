'use strict'

const P = require('bluebird')

const isWrapped = P.prototype._then.toString().includes('AsyncResource')

// eslint-disable-next-line no-console
console.log(isWrapped)
