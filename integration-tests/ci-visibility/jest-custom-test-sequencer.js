'use strict'

const Sequencer = require('@jest/test-sequencer').default

// From example in https://jestjs.io/docs/configuration#testsequencer-string
class CustomSequencer extends Sequencer {
  shard (tests, { shardIndex, shardCount }) {
    // Log used to show that the custom sequencer is being used
    // eslint-disable-next-line
    console.log('Running shard with a custom sequencer', shardIndex)
    const shardSize = Math.ceil(tests.length / shardCount)
    const shardStart = shardSize * (shardIndex - 1)
    const shardEnd = shardSize * shardIndex

    return [...tests].sort((a, b) => (a.path > b.path ? 1 : -1)).slice(shardStart, shardEnd)
  }

  sort (tests) {
    const copyTests = [...tests]
    return copyTests.sort((testA, testB) => (testA.path > testB.path ? 1 : -1))
  }
}

module.exports = CustomSequencer
