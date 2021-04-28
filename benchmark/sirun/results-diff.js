'use strict'

const { execSync } = require('child_process')

function getResults (hash) {
  return JSON.parse(execSync(`node get-results.js ${hash}`).toString('utf8'))
}

function walk (tree, oldTree) {
  if (typeof tree === 'number') {
    const diff = tree - oldTree
    const pctDiff = 100 * diff / oldTree
    return pctDiff
  }

  if (typeof tree === 'string') {
    return {
      prev: oldTree,
      curr: tree
    }
  }

  if (typeof tree === 'object') {
    const result = {}
    for (const name in tree) {
      if (name in oldTree) {
        result[name] = walk(tree[name], oldTree[name])
      }
    }
    return result
  }

  throw new Error(tree.toString())
}

module.exports = walk

if (require.main === module) {
  const commit1 = process.argv[2]
  const commit2 = process.argv[3]

  const results1 = getResults(commit1)
  const results2 = getResults(commit2)

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(walk(results2, results1), null, 2))
}
