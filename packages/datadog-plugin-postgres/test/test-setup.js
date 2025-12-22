'use strict'

class PostgresTestSetup {
  async setup (module) {
    this.sql = module({
      host: '127.0.0.1',
      port: 5432,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres'
    })

    await this.sql`
          CREATE TABLE IF NOT EXISTS test_users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            age INTEGER
          )
        `

    await this.sql`DELETE FROM test_users`
  }

  async teardown () {
    if (this.sql) {
      await this.sql.end()
    }
  }

  async queryHandle () {
    const users = await this.sql`SELECT * FROM test_users`
    return users
  }

  async queryHandleError () {
    await this.sql`SELECT * FROM nonexistent_table`
  }
}

module.exports = PostgresTestSetup
