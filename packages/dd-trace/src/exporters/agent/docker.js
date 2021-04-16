'use strict'

const fs = require('fs')

const uuidSource = '[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}'
const containerSource = '[0-9a-f]{64}'
const taskSource = '[0-9a-f]{32}-\\d+'
const entityReg = new RegExp(`.*(${uuidSource}|${containerSource}|${taskSource})(?:\\.scope)?$`, 'm')

const entityId = getEntityId()

function getEntityId () {
  const cgroup = readControlGroup() || ''
  const match = cgroup.trim().match(entityReg) || []

  return match[1]
}

function readControlGroup () {
  try {
    return fs.readFileSync('/proc/self/cgroup').toString()
  } catch (err) {
    // ignore
  }
}

module.exports = {
  // can be the container ID but not always depending on the orchestrator
  id () {
    return entityId
  }
}
