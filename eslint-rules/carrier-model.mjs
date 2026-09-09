import { Linter } from 'eslint'

/**
 * @typedef {object} CarrierModel
 * @property {Set<string>} fieldNames
 * @property {string | undefined} legacyBaggagePrefix
 * @property {Set<string>} propagationHeaders
 * @property {Map<string, string>} stringConstants
 */

/**
 * @param {import('estree').Node} node
 * @returns {string | undefined}
 */
function readStringLiteral (node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
}

/**
 * @param {import('estree').Node} node
 * @param {CarrierModel} model
 * @returns {string | undefined}
 */
function readHeaderName (node, model) {
  const literal = readStringLiteral(node)
  if (literal !== undefined) return literal
  if (node.type === 'Identifier') return model.stringConstants.get(node.name)
}

/**
 * @param {import('estree').Node} node
 * @param {Record<string, string[]>} visitorKeys
 * @param {CarrierModel} model
 * @returns {void}
 */
function collectCarrierModel (node, visitorKeys, model) {
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init &&
      node.parent.type === 'VariableDeclaration' && node.parent.kind === 'const' &&
      node.parent.parent.type === 'Program') {
    const value = readStringLiteral(node.init)
    if (value !== undefined) model.stringConstants.set(node.id.name, value)
  }

  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
      node.id.name === 'legacyBaggagePrefix' && node.init) {
    const prefix = readStringLiteral(node.init)
    const isTopLevel = node.parent.type === 'VariableDeclaration' && node.parent.parent.type === 'Program'
    if (prefix === undefined || model.legacyBaggagePrefix !== undefined || !isTopLevel) {
      throw new Error('legacyBaggagePrefix must be one top-level string literal')
    }
    model.legacyBaggagePrefix = prefix
  } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
      node.callee.name === 'defineField') {
    const parent = node.parent
    const [fieldNameNode, headerNameNode] = node.arguments
    const fieldName = fieldNameNode && fieldNameNode.type !== 'SpreadElement'
      ? readStringLiteral(fieldNameNode)
      : undefined
    const headerName = headerNameNode && headerNameNode.type !== 'SpreadElement'
      ? readHeaderName(headerNameNode, model)
      : undefined
    const declarationName = parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' &&
      parent.init === node
      ? parent.id.name
      : undefined
    const hasMatchingDeclaration = declarationName === fieldName && parent.parent.type === 'VariableDeclaration' &&
      parent.parent.parent.type === 'Program'
    const isStandalone = parent.type === 'ExpressionStatement' && parent.parent.type === 'Program'

    if (fieldName === undefined || headerName === undefined ||
        (!hasMatchingDeclaration && !isStandalone)) {
      throw new Error(
        'Each defineField call must use string literals or top-level string constants in a top-level statement ' +
        'or matching constant'
      )
    }
    if (model.fieldNames.has(fieldName) || model.propagationHeaders.has(headerName)) {
      throw new Error(`Duplicate carrier field or header declaration: ${fieldName}`)
    }

    model.fieldNames.add(fieldName)
    model.propagationHeaders.add(headerName)
  }

  for (const key of visitorKeys[node.type]) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child?.type) collectCarrierModel(child, visitorKeys, model)
      }
    } else if (value?.type) {
      collectCarrierModel(value, visitorKeys, model)
    }
  }
}

/**
 * @param {string} source
 * @returns {{ legacyBaggagePrefix: string, propagationHeaders: Set<string> }}
 */
export function parseCarrierModel (source) {
  const linter = new Linter()
  const messages = linter.verify(source, [{
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
    },
  }])
  for (const message of messages) {
    if (message.fatal) {
      throw new Error(`Unable to parse packages/dd-trace/src/carrier.js: ${message.message}`)
    }
  }

  const sourceCode = linter.getSourceCode()
  /** @type {CarrierModel} */
  const model = {
    fieldNames: new Set(),
    legacyBaggagePrefix: undefined,
    propagationHeaders: new Set(),
    stringConstants: new Map(),
  }
  collectCarrierModel(sourceCode.ast, sourceCode.visitorKeys, model)

  if (model.propagationHeaders.size === 0 || model.legacyBaggagePrefix === undefined) {
    throw new Error('Unable to discover the propagation fields declared by packages/dd-trace/src/carrier.js')
  }

  return {
    legacyBaggagePrefix: model.legacyBaggagePrefix,
    propagationHeaders: model.propagationHeaders,
  }
}
