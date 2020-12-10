const http = require('http');

function createWrapExecute (tracer, config) {
    return function wrapExecute (execute) {
        return function executeWithTrace (dbQuery, ...args) {
            return tracer.trace('exec.query', {
                tags: {
                    'span.kind': 'client', 
                    'sql.query': dbQuery
                }}, 
                (span) => {
                    const connAttrs = new URL('http://' + this._connAttrs);
                    span.setTag('db', {'instance':connAttrs.pathname.substring(1), 
                    'hostname':connAttrs.hostname, 'user':config.user, port:connAttrs.port
            });
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