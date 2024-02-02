'use strict'

function setHeader (name, value, res) {
  res.setHeader(name, value)
}

module.exports = { setHeader }
