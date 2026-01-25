'use strict'

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

class BetterSqlite3TestSetup {
  constructor () {
    this.db = null
    this.dbPath = null
  }

  setup (DatabaseModule) {
    this.Database = DatabaseModule
    this.dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`)
    this.db = new DatabaseModule(this.dbPath)

    // Create a test table with unique constraint for error testing
    this.db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE, email TEXT)')
    this.db.exec("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')")
    this.db.exec("INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')")
  }

  teardown () {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    if (this.dbPath && fs.existsSync(this.dbPath)) {
      fs.unlinkSync(this.dbPath)
    }
  }

  // Statement.run() - for INSERT/UPDATE/DELETE
  statementRun () {
    const stmt = this.db.prepare('INSERT INTO users (name, email) VALUES (?, ?)')
    return stmt.run('Charlie', 'charlie@example.com')
  }

  statementRunError () {
    // Trigger unique constraint violation during run()
    const stmt = this.db.prepare('INSERT INTO users (name, email) VALUES (?, ?)')
    return stmt.run('Alice', 'alice-duplicate@example.com') // 'Alice' already exists
  }

  // Statement.get() - for SELECT single row
  statementGet () {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?')
    return stmt.get(1)
  }

  statementGetError () {
    // Pass wrong number of parameters to trigger error during execution
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ? AND name = ?')
    return stmt.get(1) // Missing second parameter
  }

  // Statement.all() - for SELECT all rows
  statementAll () {
    const stmt = this.db.prepare('SELECT * FROM users')
    return stmt.all()
  }

  statementAllError () {
    // Pass wrong number of parameters to trigger error during execution
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ? AND name = ?')
    return stmt.all(1) // Missing second parameter
  }

  // Statement.iterate() - for iterating rows
  statementIterate () {
    const stmt = this.db.prepare('SELECT * FROM users')
    const results = []
    for (const row of stmt.iterate()) {
      results.push(row)
    }
    return results
  }

  statementIterateError () {
    // Pass wrong number of parameters to trigger error during execution
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ? AND name = ?')
    for (const _row of stmt.iterate(1)) { // Missing second parameter
      // intentionally unused
    }
  }

  // Database.exec() - for executing multiple statements
  databaseExec () {
    return this.db.exec('SELECT 1')
  }

  databaseExecError () {
    // Invalid SQL
    return this.db.exec('INVALID SQL STATEMENT')
  }
}

module.exports = BetterSqlite3TestSetup
