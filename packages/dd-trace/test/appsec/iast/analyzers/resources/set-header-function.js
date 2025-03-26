'use strict'

function setHeader (name, value, res) {
  res.setHeader(name, value)
}

function reflectPartialAcceptEncodingHeader (req, res, headerName) {
  const substringAcceptEncodingValue =
    req.headers['accept-encoding'].substring(0, req.headers['accept-encoding'].indexOf(','))
  res.setHeader(
    headerName,
    substringAcceptEncodingValue
  )
}

module.exports = {
  reflectPartialAcceptEncodingHeader,
  setHeader
}
