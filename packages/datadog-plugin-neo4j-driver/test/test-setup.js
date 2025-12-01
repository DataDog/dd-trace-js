'use strict'

class Neo4jDriverTestSetup {
  async setup (module) {
    // Connect to Neo4j
    this.driver = module.driver(
      'bolt://127.0.0.1:7687',
      module.auth.basic('neo4j', 'password')
    )

    // Verify connectivity
    await this.driver.verifyConnectivity()

    // Create a session for setup
    const session = this.driver.session()
    try {
      // Clean up any existing test data
      await session.run('MATCH (n:TestNode) DETACH DELETE n')
    } finally {
      await session.close()
    }
  }

  async teardown () {
    // Clean up test data
    const session = this.driver.session()
    try {
      await session.run('MATCH (n:TestNode) DETACH DELETE n')
    } catch (error) {
    } finally {
      await session.close()
    }

    // Close the driver
    await this.driver.close()
  }

  // --- Operations ---
  async session_run () {
    const session = this.driver.session()
    try {
      const result = await session.run(
        'CREATE (n:TestNode {name: $name, timestamp: $timestamp}) RETURN n',
        { name: 'test-node-1', timestamp: Date.now() }
      )
      const node = result.records[0].get('n')
    } catch (error) {
      throw error
    } finally {
      await session.close()
    }
  }

  async session_run_error () {
    const session = this.driver.session()
    try {
      // Invalid Cypher syntax to trigger error
      await session.run('INVALID CYPHER QUERY')
    } catch (error) {
      throw error
    } finally {
      await session.close()
    }
  }

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
    } catch (error) {
      if (tx) {
        await tx.rollback()
      }
      throw error
    } finally {
      await session.close()
    }
  }

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
      throw error
    } finally {
      await session.close()
    }
  }

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
    } catch (error) {
      throw error
    } finally {
      await session.close()
    }
  }

  async session_executeread_error () {
    const session = this.driver.session()
    try {
      await session.executeRead(async (tx) => {
        // Invalid query to trigger error
        await tx.run('INVALID READ QUERY')
      })
    } catch (error) {
      throw error
    } finally {
      await session.close()
    }
  }

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
    } catch (error) {
      throw error
    } finally {
      await session.close()
    }
  }

  async session_executewrite_error () {
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx) => {
        // Invalid query to trigger error
        await tx.run('INVALID WRITE QUERY')
      })
    } catch (error) {
      throw error
    } finally {
      await session.close()
    }
  }

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
    } catch (error) {
      if (tx) {
        await tx.rollback()
      }
      throw error
    } finally {
      await session.close()
    }
  }

  async transaction_commit_error () {
    const session = this.driver.session()
    let tx
    try {
      tx = session.beginTransaction()

      // Run a valid query first
      await tx.run('CREATE (n:TestNode {name: "test"}) RETURN n')

      // Commit the transaction
      await tx.commit()

      // Try to commit again - this should fail as transaction is already committed
      await tx.commit()
    } catch (error) {
      // Expected error from double commit
      throw error
    } finally {
      await session.close()
    }
  }

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

      // Verify the node was not created
      const verifySession = this.driver.session()
      try {
        const result = await verifySession.run(
          'MATCH (n:TestNode {name: $name}) RETURN count(n) as count',
          { name: 'test-node-rollback' }
        )
        const count = result.records[0].get('count').toNumber()
        if (count === 0) {
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
      throw error
    } finally {
      await session.close()
    }
  }

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
      throw error
    } finally {
      await session.close()
    }
  }
}

module.exports = Neo4jDriverTestSetup
