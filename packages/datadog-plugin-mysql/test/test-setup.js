'use strict'

class MysqlTestSetup {
  async setup (module) {
    try {
      // Create a connection pool
      this.pool = module.createPool({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'db',
        connectionLimit: 10
      })

      // Create a single connection for transaction testing
      this.connection = module.createConnection({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'db'
      })

      // Wait for connection to be ready
      await new Promise((resolve, reject) => {
        this.connection.connect((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      // Create test table
      await new Promise((resolve, reject) => {
        this.connection.query('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), email VARCHAR(255))', (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (error) {
      throw error
    }
  }

  async teardown () {
    try {
      // Clean up test table
      if (this.connection) {
        await new Promise((resolve) => {
          this.connection.query('DROP TABLE IF EXISTS users', () => resolve())
        })

        await new Promise((resolve) => {
          this.connection.end(() => resolve())
        })
      }

      if (this.pool) {
        await new Promise((resolve) => {
          this.pool.end(() => resolve())
        })
      }
    } catch (error) {
    }
  }

  // --- Operations ---
  async query_connection ({ expectError } = {}) {
    try {
      if (expectError) {
        await new Promise((resolve, reject) => {
          this.connection.query('SELECT * FROM nonexistent_table', (err, results) => {
            if (err) reject(err)
            else resolve(results)
          })
        })
      } else {
        const result = await new Promise((resolve, reject) => {
          this.connection.query('INSERT INTO users (name, email) VALUES (?, ?)', ['John Doe', 'john@example.com'], (err, results) => {
            if (err) reject(err)
            else resolve(results)
          })
        })
      }
    } catch (error) {
      if (expectError) {
        throw error
      }
      throw error
    }
  }

  async query_pool ({ expectError } = {}) {
    try {
      if (expectError) {
        await new Promise((resolve, reject) => {
          this.pool.query('SELECT * FROM nonexistent_table', (err, results) => {
            if (err) reject(err)
            else resolve(results)
          })
        })
      } else {
        const result = await new Promise((resolve, reject) => {
          this.pool.query('INSERT INTO users (name, email) VALUES (?, ?)', ['Jane Smith', 'jane@example.com'], (err, results) => {
            if (err) reject(err)
            else resolve(results)
          })
        })
      }
    } catch (error) {
      throw error
    }
  }

  async transaction_connection ({ expectError } = {}) {
    try {
      await new Promise((resolve, reject) => {
        this.connection.beginTransaction((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      await new Promise((resolve, reject) => {
        this.connection.rollback(() => resolve())
      })
    } catch (error) {
      throw error
    }
  }

  async commit_connection ({ expectError } = {}) {
    try {
      await new Promise((resolve, reject) => {
        this.connection.beginTransaction((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      await new Promise((resolve, reject) => {
        this.connection.commit((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (error) {
      throw error
    }
  }

  async rollback_connection ({ expectError } = {}) {
    try {
      await new Promise((resolve, reject) => {
        this.connection.beginTransaction((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      await new Promise((resolve, reject) => {
        this.connection.rollback((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (error) {
      throw error
    }
  }
}

module.exports = MysqlTestSetup
