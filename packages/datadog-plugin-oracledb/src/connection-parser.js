'use strict'

const { URL } = require('node:url')

const log = require('../../dd-trace/src/log')

const easyConnectProtocol = /^tcps?:\/\//i
let cachedConnectString
let cachedInfo

/** @param {string} descriptor */
function parseOracleDescriptor (descriptor) {
  const hostnameMatch = descriptor.match(/HOST\s*=\s*([^)]+)/i)
  const hostname = hostnameMatch?.[1]?.trim()

  const portMatch = descriptor.match(/PORT\s*=\s*([^)]+)/i)
  const port = portMatch?.[1]?.trim() || '1521'

  const sidMatch = descriptor.match(/SID\s*=\s*([^)]+)/i)

  const dbInstance = (sidMatch?.[1] || descriptor.match(/SERVICE_NAME\s*=\s*([^)]+)/i)?.[1])?.trim()

  return { hostname, port, dbInstance }
}

/** @param {{ connectString?: string, connectionString?: string }} [connAttrs] */
module.exports = function getDBInformation (connAttrs) {
  // Users can pass either connectString or connectionString
  const connectString = ((connAttrs?.connectString || connAttrs?.connectionString) ?? '').trim()
  if (connectString === cachedConnectString) return cachedInfo

  let dbInfo
  if (connectString.startsWith('(')) {
    dbInfo = parseOracleDescriptor(connectString)
  } else if (/[:/]/.test(connectString)) {
    try {
      const url = new URL(easyConnectProtocol.test(connectString) ? connectString : `oracle://${connectString}`)
      dbInfo = {
        hostname: url.hostname || undefined,
        port: url.port || '1521',
        dbInstance: url.pathname.slice(1) || undefined,
      }
    } catch (error) {
      log.error('Invalid oracle connection string', error)
      return {}
    }
  } else {
    dbInfo = {}
  }

  cachedConnectString = connectString
  cachedInfo = dbInfo
  return dbInfo
}
