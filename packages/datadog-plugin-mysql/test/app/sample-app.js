'use strict'

/* eslint-disable no-console */

const mysql = require('mysql')

class MysqlSampleApp {
  async setup () {
    try {
      // Create a connection pool
      this.pool = mysql.createPool({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'db',
        connectionLimit: 10
      })

      // Create a single connection for transaction testing
      this.connection = mysql.createConnection({
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

      console.log('✓ Connected to MySQL')

      // Create test table
      await new Promise((resolve, reject) => {
        this.connection.query('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), email VARCHAR(255))', (err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      console.log('✓ Created test table')
    } catch (error) {
      console.error(`✗ Setup error: ${error.message}`)
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
        console.log('✓ Closed connection')
      }

      if (this.pool) {
        await new Promise((resolve) => {
          this.pool.end(() => resolve())
        })
        console.log('✓ Closed pool')
      }
    } catch (error) {
      console.error(`✗ Teardown error: ${error.message}`)
    }
  }

  async query_connection () {
    try {
      const result = await new Promise((resolve, reject) => {
        this.connection.query('INSERT INTO users (name, email) VALUES (?, ?)', ['John Doe', 'john@example.com'], (err, results) => {
          if (err) reject(err)
          else resolve(results)
        })
      })
      console.log(`✓ Connection.query: Inserted user with ID ${result.insertId}`)
    } catch (error) {
      console.error(`✗ Error in query_connection: ${error.message}`)
      throw error
    }
  }

  async query_connection_error () {
    try {
      await new Promise((resolve, reject) => {
        // Intentionally query a non-existent table to trigger error
        this.connection.query('SELECT * FROM nonexistent_table', (err, results) => {
          if (err) reject(err)
          else resolve(results)
        })
      })
    } catch (error) {
      console.log(`✓ Caught expected error in query_connection_error: ${error.message}`)
      throw error
    }
  }

  async query_pool () {
    try {
      const result = await new Promise((resolve, reject) => {
        this.pool.query('INSERT INTO users (name, email) VALUES (?, ?)', ['Jane Smith', 'jane@example.com'], (err, results) => {
          if (err) reject(err)
          else resolve(results)
        })
      })
      console.log(`✓ Pool.query: Inserted user with ID ${result.insertId}`)
    } catch (error) {
      console.error(`✗ Error in query_pool: ${error.message}`)
      throw error
    }
  }

  async query_pool_error () {
    try {
      await new Promise((resolve, reject) => {
        // Intentionally use invalid SQL to trigger error
        this.pool.query('INVALID SQL SYNTAX', (err, results) => {
          if (err) reject(err)
          else resolve(results)
        })
      })
    } catch (error) {
      console.log(`✓ Caught expected error in query_pool_error: ${error.message}`)
      throw error
    }
  }

  async transaction_beginTransaction () {
    try {
      await new Promise((resolve, reject) => {
        this.connection.beginTransaction((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      console.log('✓ Transaction started with beginTransaction')

      // Insert data in transaction
      await new Promise((resolve, reject) => {
        this.connection.query('INSERT INTO users (name, email) VALUES (?, ?)', ['Transaction User', 'trans@example.com'], (err, results) => {
          if (err) reject(err)
          else resolve(results)
        })
      })
    } catch (error) {
      console.error(`✗ Error in transaction_beginTransaction: ${error.message}`)
      throw error
    }
  }

  async transaction_beginTransaction_error () {
    try {
      // Try to begin a transaction while one is already active (not actually an error in MySQL, but we can simulate)
      // Instead, let's cause an error by trying to start transaction on a closed connection
      const tempConnection = mysql.createConnection({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'db'
      })

      tempConnection.destroy() // Close immediately

      await new Promise((resolve, reject) => {
        tempConnection.beginTransaction((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (error) {
      console.log(`✓ Caught expected error in transaction_beginTransaction_error: ${error.message}`)
      throw error
    }
  }

  async commit () {
    try {
      await new Promise((resolve, reject) => {
        this.connection.commit((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      console.log('✓ Transaction committed')
    } catch (error) {
      console.error(`✗ Error in commit: ${error.message}`)
      throw error
    }
  }

  async commit_error () {
    try {
      // Try to commit without an active transaction on a fresh connection
      const tempConnection = mysql.createConnection({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'db'
      })

      await new Promise((resolve, reject) => {
        tempConnection.connect((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      tempConnection.destroy() // Close connection

      await new Promise((resolve, reject) => {
        tempConnection.commit((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      tempConnection.end()
    } catch (error) {
      console.log(`✓ Caught expected error in commit_error: ${error.message}`)
      throw error
    }
  }

  async rollback () {
    try {
      // Start a new transaction
      await new Promise((resolve, reject) => {
        this.connection.beginTransaction((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      // Insert data
      await new Promise((resolve, reject) => {
        this.connection.query('INSERT INTO users (name, email) VALUES (?, ?)', ['Rollback User', 'rollback@example.com'], (err, results) => {
          if (err) reject(err)
          else resolve(results)
        })
      })

      // Rollback
      await new Promise((resolve, reject) => {
        this.connection.rollback((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      console.log('✓ Transaction rolled back')
    } catch (error) {
      console.error(`✗ Error in rollback: ${error.message}`)
      throw error
    }
  }

  async rollback_error () {
    try {
      const tempConnection = mysql.createConnection({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'db'
      })

      await new Promise((resolve, reject) => {
        tempConnection.connect((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      tempConnection.destroy() // Close connection

      await new Promise((resolve, reject) => {
        tempConnection.rollback((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      tempConnection.end()
    } catch (error) {
      console.log(`✓ Caught expected error in rollback_error: ${error.message}`)
      throw error
    }
  }

  async runAll () {
    try {
      await this.setup()

      console.log('\n--- Testing Connection.query ---')
      try {
        await this.query_connection()
      } catch (error) {
        console.error(`Operation failed: ${error.message}`)
      }

      console.log('\n--- Testing Connection.query (error path) ---')
      try {
        await this.query_connection_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing Pool.query ---')
      try {
        await this.query_pool()
      } catch (error) {
        console.error(`Operation failed: ${error.message}`)
      }

      console.log('\n--- Testing Pool.query (error path) ---')
      try {
        await this.query_pool_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing beginTransaction + commit ---')
      try {
        await this.transaction_beginTransaction()
        await this.commit()
      } catch (error) {
        console.error(`Operation failed: ${error.message}`)
      }

      console.log('\n--- Testing beginTransaction (error path) ---')
      try {
        await this.transaction_beginTransaction_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing commit (error path) ---')
      try {
        await this.commit_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing rollback ---')
      try {
        await this.rollback()
      } catch (error) {
        console.error(`Operation failed: ${error.message}`)
      }

      console.log('\n--- Testing rollback (error path) ---')
      try {
        await this.rollback_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n✓ All operations completed')
    } catch (error) {
      console.error(`Fatal error: ${error.message}`)
      process.exit(1)
    } finally {
      await this.teardown()
    }
  }
}

// Run it
const app = new MysqlSampleApp()
app.runAll().catch(console.error)
