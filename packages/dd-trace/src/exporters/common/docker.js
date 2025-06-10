'use strict'

const fs = require('fs')
const { getEnvironmentVariable } = require('../../config-helper')

const DD_EXTERNAL_ENV = getEnvironmentVariable('DD_EXTERNAL_ENV')

// The second part is the PCF / Garden regexp. We currently assume no suffix($) to avoid matching pod UIDs
// See https://github.com/DataDog/datadog-agent/blob/7.40.x/pkg/util/cgroups/reader.go#L50
const uuidSource =
'[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}|[0-9a-f]{8}(?:-[0-9a-f]{4}){4}$'
const containerSource = '[0-9a-f]{64}'
const taskSource = String.raw`[0-9a-f]{32}-\d+`
const lineReg = /^(\d+):([^:]*):(.+)$/m
const entityReg = new RegExp(`.*(${uuidSource}|${containerSource}|${taskSource})(?:\\.scope)?$`, 'm')

let inode = 0
let cgroup = ''
let entityId

try {
  cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8').trim()
  entityId = cgroup.match(entityReg)?.[1]
} catch { /* Ignore error */ }

const inodePath = cgroup.match(lineReg)?.[3]
if (inodePath) {
  const strippedPath = inodePath.replaceAll(/^\/|\/$/g, '')

  try {
    inode = fs.statSync(`/sys/fs/cgroup/${strippedPath}`).ino
  } catch { /* Ignore error */ }
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
