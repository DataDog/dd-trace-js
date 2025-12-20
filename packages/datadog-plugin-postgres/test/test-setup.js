'use strict'

class PostgresTestSetup {
  async setup (module) {
    // Connect to PostgreSQL using standard connection parameters
    this.sql = module({
      host: '127.0.0.1',
      port: 5432,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres',
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10
    })

    // Test connection
    await this.sql`SELECT 1 as test`

    // Create test table
    await this.sql`
          CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            age INTEGER,
            email VARCHAR(100)
          )
        `

    // Insert test data
    await this.sql`
          INSERT INTO users (name, age, email)
          VALUES ('Alice', 30, 'alice@example.com'),
                 ('Bob', 25, 'bob@example.com'),
                 ('Charlie', 35, 'charlie@example.com')
          ON CONFLICT DO NOTHING
        `
  }

  async teardown () {
    if (this.sql) {
      await this.sql`DROP TABLE IF EXISTS users`.catch(() => {})
      await this.sql.end().catch(() => {})
    }
  }

  // --- Operations ---
  async connectionExecute () {
    await this.sql`SELECT * FROM users WHERE age > 20`
  }

  async connectionExecuteError () {
    // Query a non-existent table to trigger an error
    await this.sql`SELECT * FROM non_existent_table`
  }
}

module.exports = PostgresTestSetup
