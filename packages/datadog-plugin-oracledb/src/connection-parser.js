'use strict'

const { URL } = require('node:url')

const log = require('../../dd-trace/src/log')

const easyConnectProtocol = /^tcps?:\/\//i
let cachedConnectString
let cachedInfo
let cachedAllowBareHostname

/** @param {string} descriptor */
function parseOracleDescriptor (descriptor) {
  const hostnameMatch = descriptor.match(/HOST\s*=\s*([^)]+)/i)
  const hostname = hostnameMatch?.[1]

  const portMatch = descriptor.match(/PORT\s*=\s*([^)]+)/i)
  const port = portMatch?.[1] || '1521'

  const sidMatch = descriptor.match(/SID\s*=\s*([^)]+)/i)

  const dbInstance = sidMatch?.[1] || descriptor.match(/SERVICE_NAME\s*=\s*([^)]+)/i)?.[1]

  return { hostname, port, dbInstance }
}

/**
 * @param {{ connectString?: string, connectionString?: string }} [connAttrs]
 * @param {boolean} [allowBareHostname]
 */
module.exports = function getDBInformation (connAttrs, allowBareHostname = true) {
  // Users can pass either connectString or connectionString
  const connectString = ((connAttrs?.connectString || connAttrs?.connectionString) ?? '').trim()
  if (connectString === cachedConnectString && allowBareHostname === cachedAllowBareHostname) return cachedInfo

  let dbInfo
  if (connectString.startsWith('(')) {
    dbInfo = parseOracleDescriptor(connectString)
  } else if (connectString && (allowBareHostname || /[:/]/.test(connectString))) {
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
  cachedAllowBareHostname = allowBareHostname
  return dbInfo
}
