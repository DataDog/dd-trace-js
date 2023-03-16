'use strict'

const path = require('path')
const fs = require('fs')

const DD_BUNDLE_COMMENT = /\/\*\s*@dd-bundle:(.*)\s*\*\//

function isPackageIncluded (packagePath, packageName, resolveDir, builtins) {
  return !resolveDir.includes('node_modules') &&
    !builtins.has(packageName) &&
    !packageName.endsWith('package.json') &&
    packagePath.includes('appsec')
}

function readTemplate (resolveDir, tmplPath) {
  const fileContent = fs.readFileSync(path.join(resolveDir, tmplPath), 'utf-8')

  // TODO: should we escape fileContent?
  return `\`${fileContent}\``
}

function resolve (packageName, resolveDir) {
  const packageToResolve = packageName === '..' ? `../index.js` : packageName
  return require.resolve(packageToResolve, { paths: [ resolveDir ] })
}

async function getDDBundleData (packageName, resolveDir, builtins) {
  const packagePath = resolve(packageName, resolveDir)

  if (isPackageIncluded(packagePath, packageName, resolveDir, builtins)) {
    let contents
    if (fs.existsSync(packagePath)) {
      contents = await fs.promises.readFile(packagePath, 'utf-8')
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
  try {
    lines.forEach((line, index) => {
      const match = line.match(DD_BUNDLE_COMMENT)
      if (!match) return

      const expr = match[1]

      // TODO: support one expression language like spEL?
      const exprEvalMatch = expr.match(/\${(.*)}/)
      if (exprEvalMatch) {
        // eslint-disable-next-line no-unused-vars
        const template = ((base) => (path) => readTemplate(base, path))(resolveDir)

        // TODO: should we get the AST and modify the tree instead a quick line replacement?
        // eslint-disable-next-line no-eval
        const resolved = eval(exprEvalMatch[1])
        lines[index + 1] = expr.replace(exprEvalMatch[0], resolved)
      } else {
        lines[index + 1] = expr
      }
      modified = true
    })
  } catch (e) {
    modified = false
  }

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
