'use strict'

class ElectricSqlPgliteTestSetup {
  async setup (module) {
    const { PGlite } = module
    this.db = new PGlite()

    await this.db.exec(`
          CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL
          );
        `)
  }

  async teardown () {
    if (this.db) {
      await this.db.close()
    }
  }

  async basePgliteQuery () {
    const result = await this.db.query('SELECT * FROM users')
    // Verify the library returns results correctly
    if (!result || typeof result !== 'object') {
      throw new Error('Query should return a result object')
    }
    // Verify that query returns rows with expected data structure
    const rows = Array.isArray(result) ? result : result.rows
    if (!Array.isArray(rows)) {
      throw new Error('Query result should contain rows array')
    }
    return result
  }

  async basePgliteQueryError () {
    return this.db.query('SELECT * FROM nonexistent_table')
  }

  async basePgliteExec () {
    const result = await this.db.exec("INSERT INTO users (name, email) VALUES ('Test', 'test@example.com')")
    // Verify the library executes SQL correctly by checking the database state changed
    const rows = await this.db.query('SELECT COUNT(*) as count FROM users')
    const rowsArray = Array.isArray(rows) ? rows : rows.rows
    const count = rowsArray[0]?.count
    if (!count || count <= 0) {
      throw new Error('INSERT operation did not modify the database')
    }
    return result
  }

  async basePgliteExecError () {
    return this.db.exec('INSERT INTO nonexistent_table (name) VALUES (1)')
  }

  async basePgliteTransaction () {
    const result = await this.db.transaction(async (tx) => {
      const txResult = await tx.query('SELECT 1')
      // Verify the transaction executes correctly
      if (!txResult || typeof txResult !== 'object') {
        throw new Error('Transaction query should return a result object')
      }
      // Verify transaction returns query results with expected structure
      const rows = Array.isArray(txResult) ? txResult : txResult.rows
      if (!Array.isArray(rows)) {
        throw new Error('Transaction query result should contain rows array')
      }
      return txResult
    })
    return result
  }

  async basePgliteTransactionError () {
    return this.db.transaction(async (tx) => {
      throw new Error('Transaction error')
    })
  }
}

module.exports = ElectricSqlPgliteTestSetup
