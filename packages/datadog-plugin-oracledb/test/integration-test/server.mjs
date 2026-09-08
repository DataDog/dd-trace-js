import 'dd-trace/init.js'
import oracledb from 'oracledb'

const hostname = 'localhost'

const config = {
  user: 'test',
  password: 'Oracle18',
  // connect_timeout bounds the connect phase; callTimeout below bounds each query round-trip.
  connectString: `${hostname}:1521/xepdb1?connect_timeout=15`,
}

const dbQuery = 'select current_timestamp from dual'

const connection = await oracledb.getConnection(config)
// callTimeout bounds each query round-trip. No effect on IPC connections; this connects over TCP.
connection.callTimeout = 10_000
await connection.execute(dbQuery)

if (connection) {
  await connection.close()
}
