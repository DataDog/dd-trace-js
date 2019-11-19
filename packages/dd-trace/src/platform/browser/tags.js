'use strict'

const bowser = require('bowser/bundled')
const navigator = bowser.parse(window.navigator.userAgent)

module.exports = () => {
  const rum = window.DD_RUM
  const context = rum && rum.getInternalContext && rum.getInternalContext()

  return { navigator, ...context }
}
