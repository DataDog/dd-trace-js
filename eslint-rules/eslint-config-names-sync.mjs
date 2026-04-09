import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'

const IGNORED_CONFIGURATION_NAMES = new Set([
  'tracePropagationStyle',
  'tracing',
])
const UNSUPPORTED_CONFIGURATION_ROOTS = new Set([
  'isCiVisibility',
  'logger',
  'lookup',
  'plugins',
])

/**
 * @typedef {{
 *   node: import('typescript').InterfaceDeclaration | import('typescript').TypeAliasDeclaration
 *   namespaceKey: string
 *   key: string
 * }} DeclarationEntry
 */

/**
 * @typedef {{
 *   hasEnvDescendant: boolean
 *   hasBooleanBranch: boolean
 *   hasObjectBranch: boolean
 * }} TypeInspectionResult
 */

/**
 * @typedef {{
 *   names: Set<string>
 *   primaryEnvTargets: Map<string, Set<string>>
 *   knownAliasEnvNames: Set<string>
 * }} SupportedConfigurationInfo
 */

/**
 * @typedef {{
 *   declarations: Map<string, DeclarationEntry>
 *   primaryEnvTargets: Map<string, Set<string>>
 *   knownAliasEnvNames: Set<string>
 *   names: Set<string>
 *   visitedDeclarations: Set<string>
 *   envTagNamesCache: WeakMap<import('typescript').Node, Set<string>>
 *   interfacePropertiesCache: WeakMap<
 *     import('typescript').InterfaceDeclaration,
 *     Map<string, import('typescript').PropertySignature>
 *   >
 * }} InspectionState
 */

/** @type {InspectionState | undefined} */
let currentInspectionState

/**
 * @param {Partial<TypeInspectionResult>} [overrides]
 * @returns {TypeInspectionResult}
 */
function createInspectionResult (overrides) {
  return {
    hasEnvDescendant: false,
    hasBooleanBranch: false,
    hasObjectBranch: false,
    ...overrides,
  }
}

/**
 * @returns {InspectionState}
 */
function getInspectionState () {
  if (!currentInspectionState) {
    throw new Error('Inspection state not initialized.')
  }

  return currentInspectionState
}

/**
 * @param {string} filePath
 * @returns {SupportedConfigurationInfo}
 */
function getSupportedConfigurationInfo (filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const supportedConfigurations = parsed?.supportedConfigurations

  const names = new Set()
  const primaryEnvTargets = new Map()
  const knownAliasEnvNames = new Set()

  /**
   * @param {string} envName
   * @param {Set<string>} targets
   */
  function addPrimaryEnvTargets (envName, targets) {
    let existingTargets = primaryEnvTargets.get(envName)
    if (!existingTargets) {
      existingTargets = new Set()
      primaryEnvTargets.set(envName, existingTargets)
    }

    for (const target of targets) {
      existingTargets.add(target)
    }
  }

  for (const [envName, entries] of Object.entries(supportedConfigurations)) {
    /** @type {Set<string>} */
    const targets = new Set()

    for (const entry of entries) {
      if (typeof entry.internalPropertyName === 'string') {
        targets.add(entry.internalPropertyName)
      }

      for (const alias of entry.aliases ?? []) {
        if (typeof alias === 'string') {
          knownAliasEnvNames.add(alias)
        }
      }

      for (const name of entry.configurationNames ?? []) {
        if (typeof name === 'string' && !IGNORED_CONFIGURATION_NAMES.has(name)) {
          names.add(name)
          targets.add(name)
        }
      }
    }

    addPrimaryEnvTargets(envName, targets)
  }

  return { names, primaryEnvTargets, knownAliasEnvNames }
}

/**
 * @param {import('typescript').EntityName} entityName
 * @returns {string}
 */
function getEntityNameText (entityName) {
  if (ts.isIdentifier(entityName)) {
    return entityName.text
  }

  return `${getEntityNameText(entityName.left)}.${entityName.right.text}`
}

/**
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {Map<string, DeclarationEntry>}
 */
function getDeclarationRegistry (sourceFile) {
  const declarations = new Map()

  /**
   * @param {readonly import('typescript').Statement[]} statements
   * @param {string} namespaceKey
   */
  function visitStatements (statements, namespaceKey) {
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement)) {
        visitModuleDeclaration(statement, namespaceKey)
        continue
      }

      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue

      const key = namespaceKey ? `${namespaceKey}.${statement.name.text}` : statement.name.text
      declarations.set(key, {
        node: statement,
        namespaceKey,
        key,
      })
    }
  }

  /**
   * @param {import('typescript').ModuleDeclaration} declaration
   * @param {string} namespaceKey
   */
  function visitModuleDeclaration (declaration, namespaceKey) {
    const nextNamespaceKey = namespaceKey ? `${namespaceKey}.${declaration.name.text}` : declaration.name.text

    if (!declaration.body) return

    if (ts.isModuleBlock(declaration.body)) {
      visitStatements(declaration.body.statements, nextNamespaceKey)
      return
    }

    visitModuleDeclaration(
      /** @type {import('typescript').ModuleDeclaration} */ (declaration.body),
      nextNamespaceKey
    )
  }

  visitStatements(sourceFile.statements, '')

  return declarations
}

/**
 * @param {Map<string, DeclarationEntry>} declarations
 * @param {string} typeName
 * @param {string} namespaceKey
 * @returns {DeclarationEntry | undefined}
 */
function resolveDeclaration (declarations, typeName, namespaceKey) {
  let currentNamespaceKey = namespaceKey

  while (true) {
    const key = currentNamespaceKey ? `${currentNamespaceKey}.${typeName}` : typeName
    const declaration = declarations.get(key)
    if (declaration) {
      return declaration
    }

    if (!currentNamespaceKey) {
      return undefined
    }

    const lastSeparatorIndex = currentNamespaceKey.lastIndexOf('.')
    currentNamespaceKey = lastSeparatorIndex === -1
      ? ''
      : currentNamespaceKey.slice(0, lastSeparatorIndex)
  }
}

/**
 * @param {import('typescript').PropertyName} propertyName
 * @returns {string | undefined}
 */
function getPropertyName (propertyName) {
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
    return propertyName.text
  }
}

/**
 * @param {import('typescript').Node} node
 * @returns {Set<string>}
 */
function getEnvTagNames (node) {
  const { envTagNamesCache } = getInspectionState()
  const cachedNames = envTagNamesCache.get(node)
  if (cachedNames) return cachedNames

  const envTagNames = new Set()
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'env' || typeof tag.comment !== 'string') continue

    for (const match of tag.comment.matchAll(/\b(?:DD|OTEL)_[A-Z0-9_]+\b/g)) {
      envTagNames.add(match[0])
    }
  }

  envTagNamesCache.set(node, envTagNames)
  return envTagNames
}

/**
 * @param {import('typescript').InterfaceDeclaration} declaration
 * @param {string} propertyName
 * @returns {import('typescript').PropertySignature | undefined}
 */
function getInterfaceProperty (declaration, propertyName) {
  const { interfacePropertiesCache } = getInspectionState()
  let properties = interfacePropertiesCache.get(declaration)

  if (!properties) {
    properties = new Map()

    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue

      const memberName = getPropertyName(member.name)
      if (memberName) {
        properties.set(memberName, member)
      }
    }

    interfacePropertiesCache.set(declaration, properties)
  }

  return properties.get(propertyName)
}

/**
 * @param {string} fullPath
 * @param {Set<string>} envTagNames
 * @returns {boolean}
 */
function hasSupportedDirectEnvTag (fullPath, envTagNames) {
  const { primaryEnvTargets, knownAliasEnvNames } = getInspectionState()

  for (const envName of envTagNames) {
    const targets = primaryEnvTargets.get(envName)
    if (targets?.has(fullPath) || (!targets && !knownAliasEnvNames.has(envName))) {
      return true
    }
  }

  return false
}

/**
 * @param {readonly import('typescript').TypeElement[]} members
 * @param {string} namespaceKey
 * @param {string} pathPrefix
 * @returns {TypeInspectionResult}
 */
function inspectMembers (members, namespaceKey, pathPrefix) {
  const result = createInspectionResult({ hasObjectBranch: true })

  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue

    const propertyName = getPropertyName(member.name)
    if (!propertyName) continue

    const propertyResult = inspectProperty(
      member,
      namespaceKey,
      pathPrefix ? `${pathPrefix}.${propertyName}` : propertyName
    )
    result.hasEnvDescendant ||= propertyResult.hasEnvDescendant
  }

  return result
}

/**
 * @param {import('typescript').PropertySignature} property
 * @param {string} namespaceKey
 * @param {string} fullPath
 * @returns {TypeInspectionResult}
 */
function inspectProperty (property, namespaceKey, fullPath) {
  const state = getInspectionState()

  if (UNSUPPORTED_CONFIGURATION_ROOTS.has(fullPath.split('.', 1)[0])) {
    return createInspectionResult()
  }

  const result = inspectTypeNode(property.type, namespaceKey, fullPath)
  const envTagNames = getEnvTagNames(property)
  const isLeafConfiguration = !result.hasObjectBranch
  const isBooleanAlias =
    result.hasBooleanBranch &&
    result.hasObjectBranch &&
    result.hasEnvDescendant
  const hasSupportedOwnEnvTag = hasSupportedDirectEnvTag(fullPath, envTagNames)

  if (hasSupportedOwnEnvTag || isLeafConfiguration || isBooleanAlias) {
    state.names.add(fullPath)
  }

  result.hasEnvDescendant ||= hasSupportedOwnEnvTag

  return result
}

/**
 * @param {DeclarationEntry} declaration
 * @param {string} fullPath
 * @returns {TypeInspectionResult}
 */
function inspectDeclaration (declaration, fullPath) {
  const state = getInspectionState()

  if (state.visitedDeclarations.has(declaration.key)) {
    return createInspectionResult({ hasObjectBranch: true })
  }

  state.visitedDeclarations.add(declaration.key)

  try {
    return ts.isInterfaceDeclaration(declaration.node)
      ? inspectMembers(declaration.node.members, declaration.namespaceKey, fullPath)
      : inspectTypeNode(declaration.node.type, declaration.namespaceKey, fullPath)
  } finally {
    state.visitedDeclarations.delete(declaration.key)
  }
}

/**
 * @param {import('typescript').TypeNode | undefined} typeNode
 * @param {string} namespaceKey
 * @param {string} fullPath
 * @returns {TypeInspectionResult}
 */
function inspectTypeNode (typeNode, namespaceKey, fullPath) {
  const { declarations } = getInspectionState()

  if (!typeNode) {
    return createInspectionResult()
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return inspectTypeNode(typeNode.type, namespaceKey, fullPath)
  }

  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return createInspectionResult({ hasBooleanBranch: true })
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return inspectMembers(typeNode.members, namespaceKey, fullPath)
  }

  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    const result = createInspectionResult()

    for (const part of typeNode.types) {
      const partResult = inspectTypeNode(part, namespaceKey, fullPath)
      result.hasEnvDescendant ||= partResult.hasEnvDescendant
      result.hasBooleanBranch ||= partResult.hasBooleanBranch
      result.hasObjectBranch ||= partResult.hasObjectBranch
    }

    return result
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const declaration = resolveDeclaration(declarations, getEntityNameText(typeNode.typeName), namespaceKey)
    return declaration ? inspectDeclaration(declaration, fullPath) : createInspectionResult()
  }

  if (
    ts.isIndexedAccessTypeNode(typeNode) &&
    ts.isLiteralTypeNode(typeNode.indexType) &&
    ts.isStringLiteral(typeNode.indexType.literal) &&
    ts.isTypeReferenceNode(typeNode.objectType)
  ) {
    const declaration = resolveDeclaration(
      declarations,
      getEntityNameText(typeNode.objectType.typeName),
      namespaceKey
    )

    if (!declaration || !ts.isInterfaceDeclaration(declaration.node)) {
      return createInspectionResult()
    }

    const property = getInterfaceProperty(declaration.node, typeNode.indexType.literal.text)
    return property ? inspectProperty(property, declaration.namespaceKey, fullPath) : createInspectionResult()
  }

  return createInspectionResult()
}

/**
 * @param {string} filePath
 * @param {SupportedConfigurationInfo} supportedConfigurationInfo
 * @returns {Set<string>}
 */
function getIndexDtsConfigurationNames (filePath, supportedConfigurationInfo) {
  const sourceFile = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const declarations = getDeclarationRegistry(sourceFile)
  const tracerOptions = declarations.get('tracer.TracerOptions')

  if (!tracerOptions || !ts.isInterfaceDeclaration(tracerOptions.node)) {
    throw new Error('Could not resolve tracer.TracerOptions.')
  }

  const names = new Set()
  currentInspectionState = {
    declarations,
    primaryEnvTargets: supportedConfigurationInfo.primaryEnvTargets,
    knownAliasEnvNames: supportedConfigurationInfo.knownAliasEnvNames,
    names,
    visitedDeclarations: new Set(),
    envTagNamesCache: new WeakMap(),
    interfacePropertiesCache: new WeakMap(),
  }

  try {
    inspectMembers(tracerOptions.node.members, tracerOptions.namespaceKey, '')
  } finally {
    currentInspectionState = undefined
  }

  for (const ignoredConfigurationName of IGNORED_CONFIGURATION_NAMES) {
    names.delete(ignoredConfigurationName)
  }

  return names
}

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('estree').Program} node
 * @param {Set<string>} sourceNames
 * @param {Set<string>} targetNames
 * @param {string} messageId
 * @returns {void}
 */
function reportMissingConfigurations (context, node, sourceNames, targetNames, messageId) {
  const missing = []

  for (const name of sourceNames) {
    if (!targetNames.has(name)) {
      missing.push(name)
    }
  }

  for (const configurationName of missing.sort()) {
    context.report({
      node,
      messageId,
      data: { configurationName },
    })
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure supported configuration names stay in sync with index.d.ts',
    },
    schema: [{
      type: 'object',
      properties: {
        indexDtsPath: {
          type: 'string',
        },
        supportedConfigurationsPath: {
          type: 'string',
        },
      },
      additionalProperties: false,
    }],
    messages: {
      configurationMissingInIndexDts:
        "Configuration name '{{configurationName}}' exists in supported-configurations.json but not in index.d.ts.",
      configurationMissingInSupportedConfigurations:
        "Configuration name '{{configurationName}}' exists in index.d.ts but not in supported-configurations.json.",
      readFailure:
        'Unable to compare supported configuration names: {{reason}}',
    },
  },
  create (context) {
    const options = context.options[0] || {}
    const indexDtsPath = path.resolve(context.cwd, options.indexDtsPath || 'index.d.ts')
    const supportedConfigurationsPath = path.resolve(
      context.cwd,
      options.supportedConfigurationsPath || 'packages/dd-trace/src/config/supported-configurations.json'
    )

    return {
      Program (node) {
        let indexDtsNames
        let supportedConfigurationInfo

        try {
          supportedConfigurationInfo = getSupportedConfigurationInfo(supportedConfigurationsPath)
          indexDtsNames = getIndexDtsConfigurationNames(indexDtsPath, supportedConfigurationInfo)
        } catch (error) {
          context.report({
            node,
            messageId: 'readFailure',
            data: {
              reason: error instanceof Error ? error.message : String(error),
            },
          })
          return
        }

        reportMissingConfigurations(
          context,
          node,
          supportedConfigurationInfo.names,
          indexDtsNames,
          'configurationMissingInIndexDts'
        )
        reportMissingConfigurations(
          context,
          node,
          indexDtsNames,
          supportedConfigurationInfo.names,
          'configurationMissingInSupportedConfigurations'
        )
      },
    }
  },
}
