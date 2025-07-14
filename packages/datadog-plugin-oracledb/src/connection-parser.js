'use strict'

const { URL } = require('url')
const log = require('../../dd-trace/src/log')

function parseOracleDescriptor (descriptor) {
  const hostnameMatch = descriptor.match(/HOST\s*=\s*([^)]+)/i)
  const hostname = hostnameMatch?.[1] || 'localhost' // Default Oracle hostname

  const portMatch = descriptor.match(/PORT\s*=\s*([^)]+)/i)
  const port = portMatch?.[1] || '1521' // Default Oracle port

  const sidMatch = descriptor.match(/SID\s*=\s*([^)]+)/i)

  const dbInstance = sidMatch?.[1] || descriptor.match(/SERVICE_NAME\s*=\s*([^)]+)/i)?.[1] || 'XEPDB1' // Default Oracle service name

  return { hostname, port, dbInstance }
}

module.exports = function getDBInformation (connAttrs) {
  // Users can pass either connectString or connectionString
  const connectString = ((connAttrs.connectString || connAttrs.connectionString) ?? '').trim()
  if (connectString.startsWith('(')) {
    return parseOracleDescriptor(connectString)
  }
  try {
    const url = new URL(`oracle://${connectString}`)
    return {
      hostname: url.hostname || 'localhost', // Default Oracle hostname
      port: url.port || '1521', // Default Oracle port
      dbInstance: url.pathname && url.pathname.slice(1) || 'XEPDB1' // Default Oracle service name
    }
  } catch (error) {
    log.error('Invalid oracle connection string', error)
    return {}
  }
}
