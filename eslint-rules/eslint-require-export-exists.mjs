import fs from 'node:fs'
import path from 'node:path'

import { Linter } from 'eslint'

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs']
const UNKNOWN_EXPORTS = Symbol('UNKNOWN_EXPORTS')
const parserLinter = new Linter()

/**
 * @typedef {import('eslint').Rule.Node} EslintNode
 */

/**
 * @typedef {{
 *   type?: string
 *   name?: string
 *   value?: unknown
 *   computed?: boolean
 *   operator?: string
 *   object?: LooseNode
 *   property?: LooseNode
 *   callee?: LooseNode
 *   arguments?: LooseNode[]
 *   left?: LooseNode
 *   right?: LooseNode
 *   argument?: LooseNode
 *   parent?: LooseNode | null
 * }} LooseNode
 */

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function isFirstPartySpecifier (specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
}

/**
 * @param {string} importerPath
 * @param {string} specifier
 * @param {string} cwd
 * @returns {string | undefined}
 */
function resolveFirstPartyModulePath (importerPath, specifier, cwd) {
  if (!isFirstPartySpecifier(specifier)) return undefined

  let basePath
  if (specifier.startsWith('/')) {
    basePath = path.resolve(cwd, `.${specifier}`)
  } else {
    basePath = path.resolve(path.dirname(importerPath), specifier)
  }

  const resolved = resolveAsFileOrDirectory(basePath)
  if (!resolved) return undefined
  if (!resolved.startsWith(cwd)) return undefined

  return resolved
}

/**
 * @param {string} basePath
 * @returns {string | undefined}
 */
function resolveAsFileOrDirectory (basePath) {
  if (isFile(basePath)) return basePath

  for (const extension of SCRIPT_EXTENSIONS) {
    const filePath = `${basePath}${extension}`
    if (isFile(filePath)) return filePath
  }

  if (isDirectory(basePath)) {
    for (const extension of SCRIPT_EXTENSIONS) {
      const indexPath = path.join(basePath, `index${extension}`)
      if (isFile(indexPath)) return indexPath
    }
  }

  return undefined
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isFile (filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isDirectory (filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {import('estree').Property['key'] | import('estree').MemberExpression['property'] | undefined} keyNode
 * @param {boolean} computed
 * @returns {string | undefined}
 */
function getPropertyName (keyNode, computed) {
  if (!keyNode) return undefined

  if (!computed && keyNode.type === 'Identifier') return keyNode.name
  if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') return keyNode.value

  return undefined
}

/**
 * @param {LooseNode | undefined} node
 * @returns {boolean}
 */
function isModuleExportsReference (node) {
  return Boolean(
    node &&
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'module' &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'exports'
  )
}

/**
 * @param {LooseNode | undefined} node
 * @returns {boolean}
 */
function isExportsIdentifier (node) {
  return Boolean(node && node.type === 'Identifier' && node.name === 'exports')
}

/**
 * @param {import('estree').ObjectExpression} objectNode
 * @returns {Set<string> | typeof UNKNOWN_EXPORTS}
 */
function getObjectExpressionExportNames (objectNode) {
  const names = new Set()

  for (const property of objectNode.properties) {
    if (property.type !== 'Property') return UNKNOWN_EXPORTS
    if (property.kind !== 'init') return UNKNOWN_EXPORTS

    const propertyName = getPropertyName(property.key, Boolean(property.computed))
    if (!propertyName) return UNKNOWN_EXPORTS

    names.add(propertyName)
  }

  return names
}

/**
 * @param {LooseNode | undefined} left
 * @returns {{
 *   base: 'exports' | 'module.exports' | undefined
 *   property: string | undefined
 *   isDirectBaseWrite: boolean
 * }}
 */
function getExportWriteTarget (left) {
  if (!left) {
    return { base: undefined, property: undefined, isDirectBaseWrite: false }
  }

  if (isExportsIdentifier(left)) {
    return { base: 'exports', property: undefined, isDirectBaseWrite: true }
  }

  if (isModuleExportsReference(left)) {
    return { base: 'module.exports', property: undefined, isDirectBaseWrite: true }
  }

  if (left.type !== 'MemberExpression') {
    return { base: undefined, property: undefined, isDirectBaseWrite: false }
  }

  const property = getPropertyName(
    /** @type {import('estree').MemberExpression['property'] | undefined} */ (/** @type {unknown} */ (left.property)),
    Boolean(left.computed)
  )
  if (!property) return { base: undefined, property: undefined, isDirectBaseWrite: false }

  if (isExportsIdentifier(left.object)) {
    return { base: 'exports', property, isDirectBaseWrite: false }
  }

  if (isModuleExportsReference(left.object)) {
    return { base: 'module.exports', property, isDirectBaseWrite: false }
  }

  return { base: undefined, property: undefined, isDirectBaseWrite: false }
}

/**
 * @param {EslintNode} ast
 * @returns {Set<string> | typeof UNKNOWN_EXPORTS}
 */
function collectExportsFromAst (ast) {
  const exportNames = new Set()
  let unknown = false

  /** @type {LooseNode} */
  const rootNode = /** @type {LooseNode} */ (ast)

  /** @type {LooseNode[]} */
  const stack = [rootNode]
  const visited = new Set()

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    if (visited.has(node)) continue
    visited.add(node)

    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const targetNode = node.type === 'UpdateExpression' ? node.argument : node.left
      const target = getExportWriteTarget(targetNode)

      if (target.base) {
        if (target.isDirectBaseWrite) {
          if (target.base === 'module.exports' && node.type === 'AssignmentExpression' && node.operator === '=') {
            if (node.right?.type === 'ObjectExpression') {
              const objectExports = getObjectExpressionExportNames(
                /** @type {import('estree').ObjectExpression} */ (node.right)
              )
              if (objectExports === UNKNOWN_EXPORTS) {
                unknown = true
              } else {
                exportNames.clear()
                for (const name of objectExports) exportNames.add(name)
              }
            } else {
              unknown = true
            }
          } else {
            unknown = true
          }
        } else if (target.property) {
          exportNames.add(target.property)
        } else {
          unknown = true
        }
      }
    } else if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object?.type === 'Identifier' &&
      node.callee.object.name === 'Object' &&
      node.callee.property?.type === 'Identifier' &&
      node.callee.property.name === 'defineProperty'
    ) {
      const args = node.arguments || []
      if (args.length >= 2) {
        const target = args[0]
        const property = args[1]

        if (isExportsIdentifier(target) || isModuleExportsReference(target)) {
          if (property.type === 'Literal' && typeof property.value === 'string') {
            exportNames.add(property.value)
          } else {
            unknown = true
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue
      if (!value) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') stack.push(/** @type {LooseNode} */ (item))
        }
      } else if (typeof value === 'object') {
        stack.push(/** @type {LooseNode} */ (value))
      }
    }
  }

  return unknown ? UNKNOWN_EXPORTS : exportNames
}

/**
 * @param {string} targetFilePath
 * @returns {Set<string> | typeof UNKNOWN_EXPORTS}
 */
function collectExportsFromFile (targetFilePath) {
  if (path.extname(targetFilePath) === '.json') {
    return collectExportsFromJsonFile(targetFilePath)
  }

  let source
  try {
    source = fs.readFileSync(targetFilePath, 'utf8')
  } catch {
    return UNKNOWN_EXPORTS
  }

  let ast
  try {
    parserLinter.verify(source, {
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'script',
      },
      rules: {},
    }, targetFilePath)
    ast = parserLinter.getSourceCode()?.ast
  } catch {
    return UNKNOWN_EXPORTS
  }

  if (!ast) return UNKNOWN_EXPORTS

  return collectExportsFromAst(/** @type {EslintNode} */ (ast))
}

/**
 * @param {string} targetFilePath
 * @returns {Set<string> | typeof UNKNOWN_EXPORTS}
 */
function collectExportsFromJsonFile (targetFilePath) {
  let source
  try {
    source = fs.readFileSync(targetFilePath, 'utf8')
  } catch {
    return UNKNOWN_EXPORTS
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    return UNKNOWN_EXPORTS
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return UNKNOWN_EXPORTS
  }

  return new Set(Object.keys(parsed))
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure required first-party CommonJS exports exist',
    },
    schema: [],
    messages: {
      missingExport: "Module '{{moduleName}}' does not export '{{exportName}}'.",
    },
  },
  create (context) {
    const currentFile = context.filename
    const cwd = context.cwd
    const exportCache = new Map()
    const resolutionCache = new Map()

    /**
     * @param {string} specifier
     * @returns {{ specifier: string, exports: Set<string> } | undefined}
     */
    function getResolvedExportSet (specifier) {
      if (!isFirstPartySpecifier(specifier)) return undefined

      const resolutionCacheKey = `${currentFile}::${specifier}`
      if (!resolutionCache.has(resolutionCacheKey)) {
        resolutionCache.set(
          resolutionCacheKey,
          resolveFirstPartyModulePath(currentFile, specifier, cwd)
        )
      }

      const resolvedPath = resolutionCache.get(resolutionCacheKey)
      if (!resolvedPath) return undefined

      if (!exportCache.has(resolvedPath)) {
        exportCache.set(resolvedPath, collectExportsFromFile(resolvedPath))
      }

      const exports = exportCache.get(resolvedPath)
      if (!exports || exports === UNKNOWN_EXPORTS) return undefined

      return { specifier, exports }
    }

    /**
     * @param {EslintNode} node
     * @param {string} specifier
     * @param {Set<string>} exports
     * @param {string} exportName
     */
    function reportIfMissingExport (node, specifier, exports, exportName) {
      if (exports.has(exportName)) return

      context.report({
        node,
        messageId: 'missingExport',
        data: {
          moduleName: specifier,
          exportName,
        },
      })
    }

    return {
      VariableDeclarator (node) {
        if (
          node.init?.type !== 'CallExpression' ||
          node.init.callee?.type !== 'Identifier' ||
          node.init.callee.name !== 'require' ||
          node.init.arguments.length !== 1 ||
          node.init.arguments[0]?.type !== 'Literal' ||
          typeof node.init.arguments[0].value !== 'string'
        ) {
          return
        }

        const specifier = node.init.arguments[0].value
        const moduleInfo = getResolvedExportSet(specifier)
        if (!moduleInfo) return

        if (node.id.type === 'ObjectPattern') {
          for (const property of node.id.properties) {
            if (property.type !== 'Property') continue
            if (property.key.type !== 'Identifier') continue

            reportIfMissingExport(property.key, specifier, moduleInfo.exports, property.key.name)
          }
        }
      },
    }
  },
}
