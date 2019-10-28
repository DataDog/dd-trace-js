'use strict'

const bowser = require('bowser/bundled')
const navigator = bowser.parse(window.navigator.userAgent)

module.exports = () => ({ navigator })
