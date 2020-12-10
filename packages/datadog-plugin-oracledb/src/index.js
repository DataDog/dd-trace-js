const http = require('http');

function createWrapExecute (tracer, config) {
    return function wrapExecute (execute) {
        return function executeWithTrace (dbQuery, ...args) {
            return tracer.trace('exec.query', {
                tags: {
                    'span.kind': 'client', 
                    'sql.query': dbQuery
                }
            }, (span) => {
                const connAttrs = this._connAttrs
                const service = getServiceName(tracer, config, connAttrs)
                const connectStringObj = new URL('http://' + connAttrs.connectString);
                span.setTag('db', {
                    'instance':connectStringObj.pathname.substring(1), 
                    'hostname':connectStringObj.hostname, 
                    'user':config.user, 
                    'port':connectStringObj.port
                });
                span.setTag('service.name', service);
                return execute.call(this, dbQuery, ...args)
            })
        }
    }
}

function createWrapGetConnection (tracer, config) {
    return function wrapGetConnection (getConnection) {
        return async function getConnectionWithTrace (connAttrs) {
            const conn = await getConnection.call(this, connAttrs)
            conn._connAttrs = connAttrs
            return conn
        }
    }
}

function getServiceName (tracer, config, connAttrs) {
    if (typeof config.service === 'function') {
        return config.service(connAttrs)
    } else if (config.service) {
        return config.service
    } else {
        return `${tracer._service}-oracledb`
    }
}

module.exports = { 
    name: 'oracledb',
    versions: ['*'],
    patch (oracledb, tracer, config){
        this.wrap(oracledb.Connection.prototype, 'execute', createWrapExecute(tracer, config))
        this.wrap(oracledb, 'getConnection', createWrapGetConnection(tracer, config))
    },
    unpatch(oracledb) {
        this.unwrap(oracledb.Connection.prototype, 'execute')
        this.unwrap(oracledb, 'getConnection')
    }
}
