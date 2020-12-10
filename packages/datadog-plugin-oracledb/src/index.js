
function createWrapExecute (tracer, config) {
    return function wrapExecute (execute) {
        return function executeWithTrace (dbQuery, ...args) {
            return tracer.trace('exec.query', {
                tags: {
                    'span.kind': 'client', 
                    // should args get added here too?
                    'sql.query': dbQuery}}, 
                    (span) => {
                // const service = 
                const connectStringObj = new URL('http://' + config.connectString);
                // span.setTag('db', {'instance':connectStringObj.pathname.substring(1), 
                // 'hostname':connectStringObj.hostname, 'user':config.user, port:connectStringObj.port});

                
                return execute.call(this, dbQuery, ...args)
            })
        }
    }
}

module.exports = { 
    name: 'oracledb',
    versions: ['*'],
    patch (oracledb, tracer, config){
        this.wrap(oracledb.Connection.prototype, 'execute', createWrapExecute(tracer, config))
    },
    unpatch(oracledb) {
        this.unwrap(oracledb.Connection.prototype, 'execute')
    }
}
