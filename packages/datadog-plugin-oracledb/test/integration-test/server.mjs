import 'dd-trace/init.js'
import oracledb from 'oracledb'

// hardcode it to oracledb since sandbox doesn't have the PROCESS.ENV.CI flag set
for (const key in process.env) {
  console.log(`${key}: ${process.env[key]}`)
}

const hostname = 'oracledb'
console.log(13213123, hostname)
const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:1521/xepdb1`
};

const dbQuery = 'select current_timestamp from dual'

let connection;

connection = await oracledb.getConnection(config)
await connection.execute(dbQuery)

if (connection) {
  await connection.close()
}