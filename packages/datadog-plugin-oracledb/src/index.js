'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const log = require('../../dd-trace/src/log')

class OracledbPlugin extends DatabasePlugin {
  static get id () { return 'oracledb' }
  static get system () { return 'oracle' }

  start ({ query, connAttrs }) {
    const service = getServiceName(this.config, connAttrs)
    const url = getUrl(connAttrs.connectString)

    this.startSpan('oracle.query', {
      service,
      resource: query,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': this.config.user,
        'db.instance': url.pathname && url.pathname.substring(1),
        'db.hostname': url.hostname,
        [CLIENT_PORT_KEY]: url.port
      }
    })
  }
}

function getServiceName (config, connAttrs) {
  if (typeof config.service === 'function') {
    return config.service(connAttrs)
  }

  return config.service
}

// TODO: Avoid creating an error since it's a heavy operation.
function getUrl (connectString) {
  try {
    return new URL(`http://${connectString}`)
  } catch (e) {
    log.error(e)
    return {}
  }
}

module.exports = OracledbPlugin
