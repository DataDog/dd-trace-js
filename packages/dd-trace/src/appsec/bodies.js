'use strict'

const bodies = new WeakMap()

function setRequestBody (req, body) {
  bodies.set(req, body)
}

function getRequestBody (req) {
  return bodies.get(req)
}

function deleteRequestBody (req) {
  bodies.delete(req)
}

module.exports = {
  getRequestBody,
  setRequestBody,
  deleteRequestBody
}
