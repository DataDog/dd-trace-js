import oracledb from 'oracledb'

const hostname = 'localhost'

const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:1521/xepdb1`
}

const dbQuery = 'select current_timestamp from dual'

const connection = await oracledb.getConnection(config)
await connection.execute(dbQuery)

if (connection) {
  await connection.close()
}
