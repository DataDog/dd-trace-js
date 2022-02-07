// similar to packages/dd-trace/src/pkg.js, only this always returns the
// dd-trace's package (and not the version of the require.main file, for example)
const fs = require('fs')
const path = require('path')

function findUp (name, cwd) {
  let directory = path.resolve(cwd)
  const { root } = path.parse(directory)

  while (true) {
    const current = path.resolve(directory, name)

    if (fs.existsSync(current)) return current
    if (directory === root) return

    directory = path.dirname(directory)
  }
}

function getDDTracePkg () {
  const filePath = findUp('package.json', '.')

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    return {}
  }
}

module.exports = getDDTracePkg()
