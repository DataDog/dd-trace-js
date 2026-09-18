import 'dd-trace/init.js'
import tracer from 'dd-trace'
import oracledb from 'oracledb'

const hostname = 'localhost'

const config = {
  user: 'test',
  password: 'Oracle18',
  // connect_timeout bounds the connect phase; callTimeout below bounds each query round-trip.
  connectString: `${hostname}:1521/xepdb1?connect_timeout=15`,
}

const dbQuery = 'select current_timestamp from dual'
const isThickMode = process.env.ORACLEDB_THICK === 'true'

if (isThickMode) {
  oracledb.initOracleClient()
}

const pool = await oracledb.createPool(isThickMode
  ? { connectString: config.connectString, homogeneous: false, poolMin: 0 }
  : { ...config, poolMin: 0 })
const connections = []

try {
  await tracer.trace('oracledb.esm', async () => {
    connections.push(isThickMode
      ? await pool.getConnection({ user: config.user, password: config.password })
      : await pool.getConnection())

    if (isThickMode) {
      connections.push(await new Promise((resolve, reject) => {
        pool.getConnection({ user: config.user, password: config.password }, (error, connection) => {
          if (error) return reject(error)
          resolve(connection)
        })
      }))
    }

    for (const connection of connections) {
      // callTimeout bounds each query round-trip. No effect on IPC connections; this connects over TCP.
      connection.callTimeout = 10_000
      await connection.execute(dbQuery)
    }
  })
} finally {
  await Promise.all(connections.map(connection => connection.close()))
  await pool.close()
}
