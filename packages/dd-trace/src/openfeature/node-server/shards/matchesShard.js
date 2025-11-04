'use strict'

const { MD5Sharder } = require('./sharders')

function matchesShard(shard, subjectKey, customSharder) {
  const sharder = customSharder ?? new MD5Sharder()
  const assignedShard = sharder.getShard(hashKey(shard.salt, subjectKey), shard.totalShards)
  return shard.ranges.some((range) => isInShardRange(assignedShard, range))
}

function isInShardRange(shard, range) {
  return range.start <= shard && shard < range.end
}

function hashKey(salt, subjectKey) {
  return `${salt}-${subjectKey}`
}

module.exports = {
  matchesShard
}