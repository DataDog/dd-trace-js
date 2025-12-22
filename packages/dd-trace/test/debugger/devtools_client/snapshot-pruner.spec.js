'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { pruneSnapshot } = require('../../../src/debugger/devtools_client/snapshot-pruner')

require('../../setup/mocha')

describe('snapshot-pruner', function () {
  describe('pruneSnapshot', function () {
    let locals, snapshot

    beforeEach(() => {
      locals = {}
      snapshot = {
        service: 'my-service',
        hostname: 'my-host',
        message: 'my-message',
        logger: {
          name: 'test.js',
          method: 'testMethod',
          version: '1.0.0'
        },
        dd: { service: 'my-service' },
        debugger: {
          snapshot: {
            id: '12345',
            timestamp: 123456789,
            probe: { id: 'probe-1', version: 1 },
            stack: [
              { function: 'test', fileName: 'test.js', lineNumber: 10 }
            ],
            language: 'javascript',
            captures: {
              lines: {
                10: {
                  locals
                }
              }
            }
          }
        }
      }
    })

    it('should return original JSON if already under size limit', function () {
      Object.assign(locals, {
        smallVar: { type: 'number', value: '42' }
      })

      const json = JSON.stringify(snapshot)
      const size = Buffer.byteLength(json)
      const maxSize = size + 1000

      const result = pruneSnapshot(json, size, maxSize)

      assert.strictEqual(result, json)
    })

    it('should return undefined if JSON cannot be parsed', function () {
      const invalidJson = '{ invalid json'
      const result = pruneSnapshot(invalidJson, 100, 50)

      assert.strictEqual(result, undefined)
    })

    it('should handle empty captures gracefully', function () {
      const json = JSON.stringify(snapshot)
      const size = Buffer.byteLength(json)
      const maxSize = size

      const result = pruneSnapshot(json, size, maxSize)

      assert.ok(result, 'Expected pruneSnapshot() to successfully prune')
      assert.strictEqual(result, json)
    })

    it('should prune large leaf nodes to reduce size', function () {
      assertPrunedSnapshot(-100, {
        smallVar1: { type: 'number', value: '1' },
        largeVar: { type: 'string', value: 'x'.repeat(500) },
        smallVar2: { type: 'number', value: '2' },
      }, {
        smallVar1: { type: 'number', value: '1' },
        largeVar: { pruned: true },
        smallVar2: { type: 'number', value: '2' },
      })
    })

    it('should preserve schema fields at levels 0-5', function () {
      assertPrunedSnapshot(400, {
        data: { type: 'string', value: 'x'.repeat(1000) }
      }, {
        pruned: true
      })
    })

    it('should prioritize pruning nodes with notCapturedReason="depth"', function () {
      // We want to set maxSize such that pruning deepObj1+deepObj2 is sufficient,
      // or at least that the algorithm chooses them first.
      // Using size - 40 ensures we need to prune at least ~40 bytes.
      // Pruning deepObj1 gives ~26 bytes. Not enough.
      // Pruning deepObj2 gives ~26 bytes. Total 52. Enough.
      // So it should prune both deep objects and stop, preserving normal objects.
      assertPrunedSnapshot(-40, {
        deepObj1: {
          type: 'object',
          notCapturedReason: 'depth'
        },
        deepObj2: {
          type: 'object',
          notCapturedReason: 'depth'
        },
        normalObj1: { type: 'object', fields: { z: { type: 'string', value: '3'.repeat(100) } } },
        normalObj2: { type: 'object', fields: { w: { type: 'string', value: '4'.repeat(100) } } }
      }, {
        // Objects with notCapturedReason="depth" should be pruned first
        deepObj1: { pruned: true },
        deepObj2: { pruned: true },
        // Normal objects should be preserved if possible
        normalObj1: { type: 'object', fields: { z: { type: 'string', value: '3'.repeat(100) } } },
        normalObj2: { type: 'object', fields: { w: { type: 'string', value: '4'.repeat(100) } } },
      })
    })

    it('should prioritize pruning nodes with generic notCapturedReason over normal nodes', function () {
      assertPrunedSnapshot(-1, {
        objWithReason: {
          type: 'object',
          notCapturedReason: 'timeout' // Generic reason (not "depth")
        },
        normalObj: {
          type: 'string',
          value: 'x'.repeat(150)
        }
      }, {
        // Object with generic notCapturedReason should be pruned first
        objWithReason: { pruned: true },
        // Normal object should be preserved if possible
        normalObj: { type: 'string', value: 'x'.repeat(150) }
      })
    })

    it('should prioritize larger nodes when level and capture reason are equal', function () {
      assertPrunedSnapshot(-1, {
        largeObj: { type: 'string', value: 'x'.repeat(500) },
        smallObj: { type: 'string', value: 'y'.repeat(100) }
      }, {
        largeObj: { pruned: true },
        smallObj: { type: 'string', value: 'y'.repeat(100) }
      })
    })

    it('should prune deeper nested objects before shallower ones', function () {
      assertPrunedSnapshot(-1, {
        shallowObj: { type: 'object', fields: { data: { type: 'string', value: 'x'.repeat(200) } } },
        deeperObj: {
          type: 'object',
          fields: { nested: { type: 'object', fields: { deepData: { type: 'string', value: 'y'.repeat(100) } } } }
        },
      }, {
        shallowObj: { type: 'object', fields: { data: { type: 'string', value: 'x'.repeat(200) } } },
        deeperObj: { pruned: true }
      })
    })

    it('should return undefined if no prunable nodes are available', function () {
      delete snapshot.debugger.snapshot.captures

      const json = JSON.stringify(snapshot)
      const size = Buffer.byteLength(json)
      // Set maxSize impossibly low - all content is schema
      const maxSize = 10

      const result = pruneSnapshot(json, size, maxSize)

      // Should return undefined because there's nothing to prune at level 5+
      assert.strictEqual(result, undefined)
    })

    it('should handle complex nested structures with multiple levels', function () {
      assertPrunedSnapshot(-100, {
        complexObj: {
          type: 'object',
          fields: {
            level1: {
              type: 'object',
              fields: {
                level2: {
                  type: 'object',
                  fields: {
                    level3: {
                      type: 'object',
                      fields: {
                        level4: {
                          type: 'object',
                          fields: {
                            level5: {
                              type: 'object',
                              fields: {
                                level6a: {
                                  type: 'string',
                                  value: 'x'.repeat(500)
                                },
                                // Add an extra random field to make sure we don't prune the parent when all children
                                // are pruned
                                level6b: {
                                  type: 'number',
                                  value: 42
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }, {
        complexObj: {
          type: 'object',
          fields: {
            level1: {
              type: 'object',
              fields: {
                level2: {
                  type: 'object',
                  fields: {
                    level3: {
                      type: 'object',
                      fields: {
                        level4: {
                          type: 'object',
                          fields: {
                            level5: {
                              type: 'object',
                              fields: {
                                level6a: { pruned: true },
                                level6b: {
                                  type: 'number',
                                  value: 42
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      })
    })

    it('should handle stringified JSON in keys and values', function () {
      assertPrunedSnapshot(-100, {
        // Value contains stringified JSON that looks like notCapturedReason
        strWithNotCaptured: { type: 'string', value: '{"notCapturedReason":"depth","type":"object"}' },
        // Value contains stringified JSON that looks like pruned marker
        strWithPruned: { type: 'string', value: '{"pruned":true}' },
        // Normal large value that should actually be pruned
        actualLargeValue: { type: 'string', value: 'x'.repeat(500) },
        smallValue: { type: 'number', value: '42' }
      }, {
        strWithNotCaptured: { type: 'string', value: '{"notCapturedReason":"depth","type":"object"}' },
        strWithPruned: { type: 'string', value: '{"pruned":true}' },
        actualLargeValue: { pruned: true },
        smallValue: { type: 'number', value: '42' }
      })
    })

    it('should handle escape sequences in string values', function () {
      assertPrunedSnapshot(-100, {
        // String ending with escaped backslash - this is the tricky case
        // JSON: "test\\" represents the string: test\
        escapedBackslash: { type: 'string', value: 'test\\' },
        // String with escaped quote in the middle
        escapedQuote: { type: 'string', value: 'test"quote' },
        // String with multiple escape sequences
        multipleEscapes: { type: 'string', value: 'line1\\nline2\\"quoted\\"' },
        // Large value to force pruning
        largeValue: { type: 'string', value: 'x'.repeat(500) },
        smallValue: { type: 'number', value: '1' }
      }, {
        escapedBackslash: { type: 'string', value: 'test\\' },
        escapedQuote: { type: 'string', value: 'test"quote' },
        multipleEscapes: { type: 'string', value: 'line1\\nline2\\"quoted\\"' },
        largeValue: { pruned: true },
        smallValue: { type: 'number', value: '1' }
      })
    })

    it('should handle very large snapshots efficiently', function () {
      for (let i = 0; i < 100; i++) {
        locals[`var${i}`] = { type: 'string', value: 'x'.repeat(1000) }
      }

      const json = JSON.stringify(snapshot)
      const size = Buffer.byteLength(json)
      const maxSize = 5000

      const start = process.hrtime.bigint()
      const result = pruneSnapshot(json, size, maxSize)
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000

      assert.ok(result, 'Expected pruneSnapshot() to successfully prune')

      // The algorithm tries to prune to target but may not always hit exactly
      // Just verify significant reduction happened
      const reduction = size - Buffer.byteLength(result)
      assert.ok(reduction > size * 0.9) // At least 90% reduction

      // Should complete in reasonable time
      assert.ok(elapsed < 30, `Expected elapsed time to be less than 30ms, but got ${elapsed}ms`)
    })

    it('should promote parent to leaf when all children are pruned', function () {
      // At 674, all the children are pruned, but the parent is not, at 675 one of the children is not pruned
      assertPrunedSnapshot(674, {
        smallVar: { type: 'number', value: '42' },
        parent: {
          type: 'object',
          fields: {
            child1: {
              type: 'object',
              fields: {
                data: { type: 'string', value: 'x'.repeat(100) }
              }
            },
            child2: {
              type: 'object',
              fields: {
                data: { type: 'string', value: 'y'.repeat(100) }
              }
            }
          }
        }
      }, {
        smallVar: { type: 'number', value: '42' },
        parent: { pruned: true }
      })
    })

    it('should handle multi-byte characters correctly', function () {
      // All objects have the same character length (100 chars + wrapper).
      // But emojiStr is much larger in bytes (400 bytes vs 100 bytes).
      // Algorithm should prioritize pruning the larger one (emojiStr) if levels are equal.
      // Set limit to force pruning of the larger one only.
      assertPrunedSnapshot(-200, {
        normalStr1: { type: 'string', value: 'x'.repeat(100) },
        emojiStr: { type: 'string', value: '🔒'.repeat(100) }, // Emoji is 4 bytes
        normalStr2: { type: 'string', value: 'x'.repeat(100) },
      }, {
        normalStr1: { type: 'string', value: 'x'.repeat(100) },
        emojiStr: { pruned: true },
        normalStr2: { type: 'string', value: 'x'.repeat(100) },
      })
    })

    it('should handle objects within arrays', function () {
      assertPrunedSnapshot(-1, {
        list: {
          type: 'array',
          elements: [
            {
              type: 'object',
              fields: { id: { type: 'number', value: '1' }, data: { type: 'string', value: 'x'.repeat(200) } }
            },
            {
              type: 'object',
              fields: { id: { type: 'number', value: '2' }, data: { type: 'string', value: 'y'.repeat(10) } }
            }
          ]
        }
      }, {
        list: {
          type: 'array',
          elements: [
            {
              type: 'object',
              fields: { id: { type: 'number', value: '1' }, data: { pruned: true } }
            },
            {
              type: 'object',
              fields: { id: { type: 'number', value: '2' }, data: { type: 'string', value: 'y'.repeat(10) } }
            }
          ]
        }
      })
    })

    it('should prune objects inside Map entries (arrays of arrays)', function () {
      assertPrunedSnapshot(-1, {
        myMap: {
          type: 'map',
          entries: [
            [
              { type: 'string', value: 'key1' },
              { type: 'string', value: 'x'.repeat(500) } // Should be pruned
            ],
            [
              { type: 'string', value: 'key2' },
              { type: 'string', value: 'small' }
            ]
          ]
        }
      }, {
        myMap: {
          type: 'map',
          entries: [
            [
              { type: 'string', value: 'key1' },
              { pruned: true }
            ],
            [
              { type: 'string', value: 'key2' },
              { type: 'string', value: 'small' }
            ]
          ]
        }
      })
    })

    /**
     * Assert that the pruneSnapshot function successfully prunes the snapshot and returns the expected locals.
     * @param {number} maxSize - Used to define the max allowed size of the snapshot. If positive, it's the absolute max
     *   size value. If negative, it's redacted from the actual size.
     * @param {Object} originalLocals - The locals to use for the snapshot.
     * @param {Object} expectedLocals - The expected locals after pruning.
     */
    function assertPrunedSnapshot (maxSize, originalLocals, expectedLocals) {
      Object.assign(locals, originalLocals)

      const json = JSON.stringify(snapshot)
      const size = Buffer.byteLength(json)
      maxSize = maxSize < 0 ? size + maxSize : maxSize

      const result = pruneSnapshot(json, size, maxSize)

      assert.ok(result, 'Expected pruneSnapshot() to successfully prune')

      const parsed = JSON.parse(result)
      const parsedLocals = parsed.debugger.snapshot.captures.lines['10'].locals

      assert.deepStrictEqual(parsedLocals, expectedLocals)
    }
  })
})
