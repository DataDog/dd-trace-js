import 'dd-trace/init.js'
import oracledb from 'oracledb'

const hostname = process.env.CI ? 'oracledb' : 'localhost'
const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:1521/xepdb1`
}

const dbQuery = 'select current_timestamp from dual'

const connection = await oracledb.getConnection({
  ...config,
  connectString: `
    (DESCRIPTION=
      (ADDRESS=(PROTOCOL=TCP)(HOST=${hostname})(PORT=1521))
      (CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=xepdb1))
    )
  `
})
await connection.execute(dbQuery)
await connection.close()