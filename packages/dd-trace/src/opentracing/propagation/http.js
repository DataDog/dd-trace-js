'use strict'

const TextMapPropagator = require('./text-map')

class HttpPropagator extends TextMapPropagator {}

module.exports = HttpPropagator
