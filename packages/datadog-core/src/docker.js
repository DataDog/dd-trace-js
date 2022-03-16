'use strict'

const fs = require('fs')

const uuidSource = '[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}'
const containerSource = '[0-9a-f]{64}'
const taskSource = '[0-9a-f]{32}-\\d+'
const dockerReg = new RegExp(`.*(${uuidSource}|${containerSource}|${taskSource})(?:\\.scope)?$`, 'm')

const dockerId = getDockerId()

function getDockerId () {
  const cgroup = readControlGroup() || ''
  const match = cgroup.trim().match(dockerReg) || []

  return match[1]
}

function readControlGroup () {
  try {
    return fs.readFileSync('/proc/self/cgroup').toString()
  } catch (err) {
    // ignore
  }
}

module.exports = { dockerId }
