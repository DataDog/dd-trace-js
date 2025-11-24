'use strict'

/* eslint-disable no-console */

const neo4j = require('neo4j-driver')

class Neo4jDriverSampleApp {
  async setup () {
    // Connect to Neo4j
    this.driver = neo4j.driver(
      'bolt://127.0.0.1:7687',
      neo4j.auth.basic('neo4j', 'password')
    )

    // Verify connectivity
    await this.driver.verifyConnectivity()
    console.log('✓ Connected to Neo4j')

    // Create a session for setup
    const session = this.driver.session()
    try {
      // Clean up any existing test data
      await session.run('MATCH (n:TestNode) DETACH DELETE n')
      console.log('✓ Cleaned up existing test data')
    } finally {
      await session.close()
    }
  }

  async teardown () {
    // Clean up test data
    const session = this.driver.session()
    try {
      await session.run('MATCH (n:TestNode) DETACH DELETE n')
      console.log('✓ Cleaned up test data')
    } catch (error) {
      console.error(`✗ Error cleaning up: ${error.message}`)
    } finally {
      await session.close()
    }

    // Close the driver
    await this.driver.close()
    console.log('✓ Closed Neo4j driver')
  }

  // Session.run - Execute a Cypher query directly on a session
  async session_run () {
    const session = this.driver.session()
    try {
      const result = await session.run(
        'CREATE (n:TestNode {name: $name, timestamp: $timestamp}) RETURN n',
        { name: 'test-node-1', timestamp: Date.now() }
      )
      const node = result.records[0].get('n')
      console.log(`✓ session_run: Created node with id ${node.identity}`)
    } catch (error) {
      console.error(`✗ Error in session_run: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Session.run error path - intentionally cause an error
  async session_run_error () {
    const session = this.driver.session()
    try {
      // Invalid Cypher syntax to trigger error
      await session.run('INVALID CYPHER QUERY')
    } catch (error) {
      console.log(`✓ session_run_error: Caught expected error: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Transaction.run - Execute a query within an explicit transaction
  async transaction_run () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      const result = await tx.run(
        'CREATE (n:TestNode {name: $name, timestamp: $timestamp}) RETURN n',
        { name: 'test-node-tx', timestamp: Date.now() }
      )

      await tx.commit()

      const node = result.records[0].get('n')
      console.log(`✓ transaction_run: Created node with id ${node.identity}`)
    } catch (error) {
      if (tx) {
        await tx.rollback()
      }
      console.error(`✗ Error in transaction_run: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Transaction.run error path - intentionally cause an error
  async transaction_run_error () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      // Invalid Cypher syntax to trigger error
      await tx.run('INVALID CYPHER IN TRANSACTION')

      await tx.commit()
    } catch (error) {
      if (tx) {
        await tx.rollback()
      }
      console.log(`✓ transaction_run_error: Caught expected error: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Session.executeRead - Managed read transaction
  async session_executeread () {
    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx) => {
        const queryResult = await tx.run(
          'MATCH (n:TestNode) RETURN n.name as name, n.timestamp as timestamp LIMIT 5'
        )
        return queryResult.records.map(record => ({
          name: record.get('name'),
          timestamp: record.get('timestamp')
        }))
      })

      console.log(`✓ session_executeread: Read ${result.length} nodes`)
    } catch (error) {
      console.error(`✗ Error in session_executeread: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Session.executeRead error path - intentionally cause an error
  async session_executeread_error () {
    const session = this.driver.session()
    try {
      await session.executeRead(async (tx) => {
        // Invalid query to trigger error
        await tx.run('INVALID READ QUERY')
      })
    } catch (error) {
      console.log(`✓ session_executeread_error: Caught expected error: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Session.executeWrite - Managed write transaction
  async session_executewrite () {
    const session = this.driver.session()
    try {
      const result = await session.executeWrite(async (tx) => {
        const queryResult = await tx.run(
          'CREATE (n:TestNode {name: $name, timestamp: $timestamp}) RETURN n',
          { name: 'test-node-managed', timestamp: Date.now() }
        )
        return queryResult.records[0].get('n')
      })

      console.log(`✓ session_executewrite: Created node with id ${result.identity}`)
    } catch (error) {
      console.error(`✗ Error in session_executewrite: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Session.executeWrite error path - intentionally cause an error
  async session_executewrite_error () {
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx) => {
        // Invalid query to trigger error
        await tx.run('INVALID WRITE QUERY')
      })
    } catch (error) {
      console.log(`✓ session_executewrite_error: Caught expected error: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Transaction.commit - Commit an explicit transaction
  async transaction_commit () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      await tx.run(
        'CREATE (n:TestNode {name: $name, timestamp: $timestamp}) RETURN n',
        { name: 'test-node-commit', timestamp: Date.now() }
      )

      await tx.commit()
      console.log('✓ transaction_commit: Transaction committed successfully')
    } catch (error) {
      if (tx) {
        await tx.rollback()
      }
      console.error(`✗ Error in transaction_commit: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Transaction.commit error path - intentionally cause an error
  async transaction_commit_error () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      // Create an invalid state before commit
      await tx.run('INVALID QUERY BEFORE COMMIT')

      await tx.commit()
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch (rollbackError) {
          // Ignore rollback errors in error path
        }
      }
      console.log(`✓ transaction_commit_error: Caught expected error: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Transaction.rollback - Rollback an explicit transaction
  async transaction_rollback () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      await tx.run(
        'CREATE (n:TestNode {name: $name, timestamp: $timestamp}) RETURN n',
        { name: 'test-node-rollback', timestamp: Date.now() }
      )

      // Intentionally rollback
      await tx.rollback()
      console.log('✓ transaction_rollback: Transaction rolled back successfully')

      // Verify the node was not created
      const verifySession = this.driver.session()
      try {
        const result = await verifySession.run(
          'MATCH (n:TestNode {name: $name}) RETURN count(n) as count',
          { name: 'test-node-rollback' }
        )
        const count = result.records[0].get('count').toNumber()
        if (count === 0) {
          console.log('✓ transaction_rollback: Verified node was not created (rollback worked)')
        }
      } finally {
        await verifySession.close()
      }
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch (rollbackError) {
          // Ignore rollback errors
        }
      }
      console.error(`✗ Error in transaction_rollback: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  // Transaction.rollback error path - intentionally cause an error
  async transaction_rollback_error () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      // Commit the transaction first, then try to rollback (should fail)
      await tx.run('CREATE (n:TestNode {name: "test"}) RETURN n')
      await tx.commit()

      // This should fail because transaction is already committed
      await tx.rollback()
    } catch (error) {
      console.log(`✓ transaction_rollback_error: Caught expected error: ${error.message}`)
      throw error
    } finally {
      await session.close()
    }
  }

  async runAll () {
    try {
      await this.setup()

      console.log('\n--- Testing Session.run ---')
      try {
        await this.session_run()
      } catch (error) {
        console.error('session_run failed, continuing...')
      }

      console.log('\n--- Testing Session.run (error path) ---')
      try {
        await this.session_run_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing Transaction.run ---')
      try {
        await this.transaction_run()
      } catch (error) {
        console.error('transaction_run failed, continuing...')
      }

      console.log('\n--- Testing Transaction.run (error path) ---')
      try {
        await this.transaction_run_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing Session.executeRead ---')
      try {
        await this.session_executeread()
      } catch (error) {
        console.error('session_executeread failed, continuing...')
      }

      console.log('\n--- Testing Session.executeRead (error path) ---')
      try {
        await this.session_executeread_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing Session.executeWrite ---')
      try {
        await this.session_executewrite()
      } catch (error) {
        console.error('session_executewrite failed, continuing...')
      }

      console.log('\n--- Testing Session.executeWrite (error path) ---')
      try {
        await this.session_executewrite_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing Transaction.commit ---')
      try {
        await this.transaction_commit()
      } catch (error) {
        console.error('transaction_commit failed, continuing...')
      }

      console.log('\n--- Testing Transaction.commit (error path) ---')
      try {
        await this.transaction_commit_error()
      } catch (error) {
        // Expected error
      }

      console.log('\n--- Testing Transaction.rollback ---')
      try {
        await this.transaction_rollback()
      } catch (error) {
        console.error('transaction_rollback failed, continuing...')
      }

      console.log('\n--- Testing Transaction.rollback (error path) ---')
      try {
        await this.transaction_rollback_error()
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
const app = new Neo4jDriverSampleApp()
app.runAll().catch(console.error)
