'use strict'

const path = require('path')
const fs = require('fs')

const DD_BUNDLE_COMMENT = /\/\*\s*@dd-bundle:(.*)\s*\*\//

function readTemplate (resolveDir, tmplPath) {
  const fileContent = fs.readFileSync(path.join(resolveDir, tmplPath), 'utf-8')
  return `\`${fileContent}\``
}

function resolve (packageName, resolveDir) {
  const packageToResolve = packageName === '..' ? `../index.js` : packageName
  return require.resolve(packageToResolve, { paths: [ resolveDir ] })
}

function getDDBundleData (packageName, resolveDir, builtins) {
  const validPackage = !resolveDir.includes('node_modules') &&
  !builtins.has(packageName) &&
  !packageName.endsWith('package.json') &&
  resolveDir.includes('appsec')

  if (validPackage) {
    const packagePath = resolve(packageName, resolveDir)
    let contents
    if (fs.existsSync(packagePath)) {
      contents = fs.readFileSync(packagePath, 'utf-8')
      if (contents.match(DD_BUNDLE_COMMENT)) {
        return {
          resolveDir,
          packagePath,
          contents
        }
      }
    }
  }
}

function replaceDDBundle ({ contents, packagePath }) {
  const resolveDir = path.dirname(packagePath)
  const lines = contents.split('\n')
  let modified = false
  lines.forEach((line, index) => {
    const m = line.match(DD_BUNDLE_COMMENT)
    if (!m) return

    const expr = m[1]

    const exprEval = expr.match(/\${(.*)}/)
    if (exprEval) {
      // eslint-disable-next-line no-unused-vars
      const template = ((base) => (path) => readTemplate(base, path))(resolveDir)
      // eslint-disable-next-line no-eval
      const resolved = eval(exprEval[1])
      lines[index + 1] = expr.replace(exprEval[0], resolved)
    } else {
      lines[index + 1] = expr
    }
    modified = true
  })

  if (modified) {
    contents = lines.join('\n')
  }
  return {
    contents,
    resolveDir
  }
}

module.exports = {
  getDDBundleData,
  replaceDDBundle
}
