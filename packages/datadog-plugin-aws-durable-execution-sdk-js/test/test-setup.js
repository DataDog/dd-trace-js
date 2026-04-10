'use strict'

const {
  withDurableExecution,
  DurableExecutionInvocationInputWithClient
/**
 * Mock DurableExecutionClient that provides in-memory checkpoint storage.
 * Returns checkpoint responses that mark operations as SUCCEEDED so that
 * durable operations (step, wait, etc.) can resolve without a real AWS backend.
 */

class AwsDurableExecutionSdkJsTestSetup {
  async setup (module) {
    // TODO: Implement setup logic.
  }

  async teardown () {
    // TODO: Implement teardown logic.
  }

  // --- Operations ---

}

module.exports = AwsDurableExecutionSdkJsTestSetup
