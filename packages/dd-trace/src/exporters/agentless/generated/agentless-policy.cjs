// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

"use strict"

const { randomFillSync } = require("node:crypto")

/** @param {Uint8Array} [wasm] */
function loadAgentlessPolicy (wasm = Buffer.from(require("./agentless-policy-bytes.cjs"), "base64")) {
  const compiled = new WebAssembly.Module(wasm)

  /**
   * @param {Record<string, unknown>} config
   * @param {Record<string, string>} metadata
   * @param {boolean} [clientComputedTopLevel]
   */
  return function createAgentlessPolicy (config, metadata, clientComputedTopLevel = false) {
    const instance = new WebAssembly.Instance(compiled, {
      wasi_snapshot_preview1: {
        environ_get () {
          return 0
        },
        environ_sizes_get (count, length) {
          const view = new DataView(memory.buffer)
          view.setUint32(count >>> 0, 0, true)
          view.setUint32(length >>> 0, 0, true)
          return 0
        },
        random_get (address, length) {
          randomFillSync(new Uint8Array(memory.buffer, address >>> 0, length >>> 0))
          return 0
        },
        fd_write () {
          throw new Error("Agentless policy reported a fatal error")
        },
        proc_exit (status) {
          throw new Error(`Agentless policy exited with status ${status}`)
        },
      },
    })
    const guest = instance.exports
    const memory = guest.memory

    /** @param {Uint8Array} bytes */
    function write (bytes) {
      if (bytes.byteLength > 0xffffffff) {
        return false
      }
      const address = guest.input_buffer(bytes.byteLength) >>> 0
      if (address === 0) {
        return false
      }
      new Uint8Array(memory.buffer, address, bytes.byteLength).set(bytes)
      return true
    }

    /**
     * @param {Record<string, string>} fields
     * @param {boolean} [topLevel]
     */
    function configureMetadata (fields, topLevel = false) {
      if (!write(Buffer.from(JSON.stringify(fields))) || guest.configure_metadata(Number(topLevel)) !== 1) {
        throw new Error("Invalid agentless policy metadata")
      }
    }

    if (!write(Buffer.from(JSON.stringify(config))) || guest.configure() !== 1) {
      throw new Error("Invalid agentless policy configuration")
    }
    configureMetadata(metadata, clientComputedTopLevel)

    return {
      configureMetadata,
      /**
       * @param {Uint8Array} input
       * @param {boolean} [clientSideStats]
       */
      prepare (input, clientSideStats = false) {
        if (!write(input)) {
          return undefined
        }
        const length = guest.prepare(Number(clientSideStats)) >>> 0
        if (length === 0) {
          return undefined
        }
        const address = guest.output_buffer() >>> 0
        if (address === 0) {
          throw new Error("Missing agentless policy output")
        }
        return Buffer.from(new Uint8Array(memory.buffer, address, length))
      },
    }
  }
}

module.exports = loadAgentlessPolicy
