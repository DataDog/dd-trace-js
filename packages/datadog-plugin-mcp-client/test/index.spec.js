'use strict'

// mcp-client is a pure ESM package ("type": "module") so it cannot be loaded
// via require(). All tests use the subprocess-based ESM integration test pattern.
require('./integration-test/client.spec')
