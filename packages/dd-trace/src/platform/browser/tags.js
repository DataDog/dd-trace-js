'use strict'

const bowser = require('bowser')
const navigator = bowser.parse(window.navigator.userAgent)

module.exports = () => ({ navigator })
