'use strict'

const fs = require('fs')

const { DD_EXTERNAL_ENV } = process.env

// The second part is the PCF / Garden regexp. We currently assume no suffix($) to avoid matching pod UIDs
// See https://github.com/DataDog/datadog-agent/blob/7.40.x/pkg/util/cgroups/reader.go#L50
const uuidSource =
'[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}|[0-9a-f]{8}(?:-[0-9a-f]{4}){4}$'
const containerSource = '[0-9a-f]{64}'
const taskSource = '[0-9a-f]{32}-\\d+'
const lineReg = /^(\d+):([^:]*):(.+)$/m
const entityReg = new RegExp(`.*(${uuidSource}|${containerSource}|${taskSource})(?:\\.scope)?$`, 'm')

const cgroup = readControlGroup()
const entityId = getEntityId()
const inode = getInode()

function getEntityId () {
  const match = cgroup.match(entityReg) || []

  return match[1]
}

function getInode () {
  const match = cgroup.match(lineReg) || []

  return readInode(match[3])
}

function readControlGroup () {
  try {
    return fs.readFileSync('/proc/self/cgroup').toString().trim()
  } catch (err) {
    return ''
  }
}

function readInode (path) {
  if (!path) return 0

  const strippedPath = path.replace(/^\//, '').replace(/\/$/, '')

  try {
    return fs.statSync(`/sys/fs/cgroup/${strippedPath}`).ino
  } catch (err) {
    return 0
  }
}

module.exports = {
  inject (carrier) {
    if (entityId) {
      carrier['Datadog-Container-Id'] = entityId
      carrier['Datadog-Entity-ID'] = `ci-${entityId}`
    } else if (inode) {
      carrier['Datadog-Entity-ID'] = `in-${inode}`
    }

    if (DD_EXTERNAL_ENV) {
      carrier['Datadog-External-Env'] = DD_EXTERNAL_ENV
    }
  }
}
