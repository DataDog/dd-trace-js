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

const supportedConfigurationInfoCache = new Map()
const indexDtsConfigurationNamesCache = new Map()
const envTagNamesCache = new WeakMap()
const interfacePropertiesCache = new WeakMap()

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
 *   envTargets: Map<string, Set<string>>
 * }} SupportedConfigurationInfo
 */

/**
 * @returns {TypeInspectionResult}
 */
function createEmptyInspectionResult () {
  return {
    hasEnvDescendant: false,
    hasBooleanBranch: false,
    hasObjectBranch: false,
  }
}

/**
 * @returns {TypeInspectionResult}
 */
function createRecursiveInspectionResult () {
  return {
    hasEnvDescendant: false,
    hasBooleanBranch: false,
    hasObjectBranch: true,
  }
}

/**
 * @returns {TypeInspectionResult}
 */
function createObjectInspectionResult () {
  return {
    hasEnvDescendant: false,
    hasBooleanBranch: false,
    hasObjectBranch: true,
  }
}

/**
 * @returns {TypeInspectionResult}
 */
function createBooleanInspectionResult () {
  return {
    hasEnvDescendant: false,
    hasBooleanBranch: true,
    hasObjectBranch: false,
  }
}

/**
 * @param {TypeInspectionResult} target
 * @param {TypeInspectionResult} source
 * @returns {TypeInspectionResult}
 */
function mergeInspectionResult (target, source) {
  target.hasEnvDescendant ||= source.hasEnvDescendant
  target.hasBooleanBranch ||= source.hasBooleanBranch
  target.hasObjectBranch ||= source.hasObjectBranch
  return target
}

/**
 * @param {string} namespaceKey
 * @param {string} name
 * @returns {string}
 */
function qualifyName (namespaceKey, name) {
  return namespaceKey ? `${namespaceKey}.${name}` : name
}

/**
 * @param {string} pathPrefix
 * @param {string} name
 * @returns {string}
 */
function appendPath (pathPrefix, name) {
  return pathPrefix ? `${pathPrefix}.${name}` : name
}

/**
 * @param {string} fullPath
 * @returns {string}
 */
function getRootPathSegment (fullPath) {
  const separatorIndex = fullPath.indexOf('.')
  return separatorIndex === -1 ? fullPath : fullPath.slice(0, separatorIndex)
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function readFile (filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * @param {string} filePath
 * @returns {SupportedConfigurationInfo}
 */
function getSupportedConfigurationInfo (filePath) {
  const cachedInfo = supportedConfigurationInfoCache.get(filePath)
  if (cachedInfo) return cachedInfo

  const parsed = JSON.parse(readFile(filePath))
  const supportedConfigurations = parsed?.supportedConfigurations
  if (
    !supportedConfigurations ||
    typeof supportedConfigurations !== 'object' ||
    Array.isArray(supportedConfigurations)
  ) {
    throw new Error('Expected a supportedConfigurations object.')
  }

  const names = new Set()
  const envTargets = new Map()

  /**
   * @param {string} envName
   * @param {Set<string>} targets
   */
  function addEnvTargets (envName, targets) {
    let existingTargets = envTargets.get(envName)
    if (!existingTargets) {
      existingTargets = new Set()
      envTargets.set(envName, existingTargets)
    }

    for (const target of targets) {
      existingTargets.add(target)
    }
  }

  for (const [envName, entries] of Object.entries(supportedConfigurations)) {
    if (!Array.isArray(entries)) continue

    /** @type {Set<string>} */
    const targets = new Set()

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue

      if (typeof entry.internalPropertyName === 'string') {
        targets.add(entry.internalPropertyName)
      }

      if (!Array.isArray(entry.configurationNames)) continue

      for (const name of entry.configurationNames) {
        if (typeof name === 'string' && !IGNORED_CONFIGURATION_NAMES.has(name)) {
          names.add(name)
          targets.add(name)
        }
      }

      if (Array.isArray(entry.aliases)) {
        for (const alias of entry.aliases) {
          if (typeof alias === 'string') {
            addEnvTargets(alias, targets)
          }
        }
      }
    }

    addEnvTargets(envName, targets)
  }

  const info = { names, envTargets }
  supportedConfigurationInfoCache.set(filePath, info)
  return info
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

      const key = qualifyName(namespaceKey, statement.name.text)
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
    const nextNamespaceKey = qualifyName(namespaceKey, declaration.name.text)

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
    const declaration = declarations.get(qualifyName(currentNamespaceKey, typeName))
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
 * @param {string} fullPath
 * @param {Set<string>} envTagNames
 * @param {Map<string, Set<string>>} supportedEnvTargets
 * @returns {boolean}
 */
function shouldAddDirectConfigurationName (fullPath, envTagNames, supportedEnvTargets) {
  let hasSupportedEnvTarget = false

  for (const envName of envTagNames) {
    const targets = supportedEnvTargets.get(envName)
    if (!targets) {
      return true
    }

    hasSupportedEnvTarget = true
    if (targets.has(fullPath)) {
      return true
    }
  }

  return !hasSupportedEnvTarget
}

/**
 * @param {string} fullPath
 * @returns {boolean}
 */
function isUnsupportedConfigurationPath (fullPath) {
  return UNSUPPORTED_CONFIGURATION_ROOTS.has(getRootPathSegment(fullPath))
}

/**
 * @param {import('typescript').InterfaceDeclaration} declaration
 * @param {string} propertyName
 * @returns {import('typescript').PropertySignature | undefined}
 */
function getInterfaceProperty (declaration, propertyName) {
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
 * @param {readonly import('typescript').TypeElement[]} members
 * @param {string} namespaceKey
 * @param {string} pathPrefix
 * @param {Map<string, DeclarationEntry>} declarations
 * @param {Map<string, Set<string>>} supportedEnvTargets
 * @param {Set<string>} names
 * @param {Set<string>} visitedDeclarations
 * @returns {TypeInspectionResult}
 */
function inspectMembers (
  members,
  namespaceKey,
  pathPrefix,
  declarations,
  supportedEnvTargets,
  names,
  visitedDeclarations,
) {
  const result = createObjectInspectionResult()

  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue

    const propertyName = getPropertyName(member.name)
    if (!propertyName) continue

    const propertyResult = inspectProperty(
      member,
      namespaceKey,
      appendPath(pathPrefix, propertyName),
      declarations,
      supportedEnvTargets,
      names,
      visitedDeclarations
    )
    result.hasEnvDescendant ||= propertyResult.hasEnvDescendant
  }

  return result
}

/**
 * @param {import('typescript').PropertySignature} property
 * @param {string} namespaceKey
 * @param {string} fullPath
 * @param {Map<string, DeclarationEntry>} declarations
 * @param {Map<string, Set<string>>} supportedEnvTargets
 * @param {Set<string>} names
 * @param {Set<string>} visitedDeclarations
 * @returns {TypeInspectionResult}
 */
function inspectProperty (
  property,
  namespaceKey,
  fullPath,
  declarations,
  supportedEnvTargets,
  names,
  visitedDeclarations,
) {
  if (isUnsupportedConfigurationPath(fullPath)) {
    return createEmptyInspectionResult()
  }

  const result = inspectTypeNode(
    property.type,
    namespaceKey,
    fullPath,
    declarations,
    supportedEnvTargets,
    names,
    visitedDeclarations
  )
  const envTagNames = getEnvTagNames(property)
  const hasOwnEnvTag = envTagNames.size > 0
  const isLeafConfiguration = !result.hasObjectBranch
  const isBooleanAlias =
    result.hasBooleanBranch &&
    result.hasObjectBranch &&
    result.hasEnvDescendant

  if (
    (hasOwnEnvTag && shouldAddDirectConfigurationName(fullPath, envTagNames, supportedEnvTargets)) ||
    isLeafConfiguration ||
    isBooleanAlias
  ) {
    names.add(fullPath)
  }

  if (hasOwnEnvTag) {
    result.hasEnvDescendant = true
  }

  return result
}

/**
 * @param {DeclarationEntry} declaration
 * @param {string} fullPath
 * @param {Map<string, DeclarationEntry>} declarations
 * @param {Map<string, Set<string>>} supportedEnvTargets
 * @param {Set<string>} names
 * @param {Set<string>} visitedDeclarations
 * @returns {TypeInspectionResult}
 */
function inspectDeclaration (
  declaration,
  fullPath,
  declarations,
  supportedEnvTargets,
  names,
  visitedDeclarations,
) {
  if (visitedDeclarations.has(declaration.key)) {
    return createRecursiveInspectionResult()
  }

  visitedDeclarations.add(declaration.key)

  const result = ts.isInterfaceDeclaration(declaration.node)
    ? inspectMembers(
      declaration.node.members,
      declaration.namespaceKey,
      fullPath,
      declarations,
      supportedEnvTargets,
      names,
      visitedDeclarations
    )
    : inspectTypeNode(
      declaration.node.type,
      declaration.namespaceKey,
      fullPath,
      declarations,
      supportedEnvTargets,
      names,
      visitedDeclarations
    )

  visitedDeclarations.delete(declaration.key)
  return result
}

/**
 * @param {import('typescript').TypeNode | undefined} typeNode
 * @param {string} namespaceKey
 * @param {string} fullPath
 * @param {Map<string, DeclarationEntry>} declarations
 * @param {Map<string, Set<string>>} supportedEnvTargets
 * @param {Set<string>} names
 * @param {Set<string>} visitedDeclarations
 * @returns {TypeInspectionResult}
 */
function inspectTypeNode (
  typeNode,
  namespaceKey,
  fullPath,
  declarations,
  supportedEnvTargets,
  names,
  visitedDeclarations,
) {
  if (!typeNode) {
    return createEmptyInspectionResult()
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return inspectTypeNode(
      typeNode.type,
      namespaceKey,
      fullPath,
      declarations,
      supportedEnvTargets,
      names,
      visitedDeclarations
    )
  }

  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return createBooleanInspectionResult()
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return inspectMembers(
      typeNode.members,
      namespaceKey,
      fullPath,
      declarations,
      supportedEnvTargets,
      names,
      visitedDeclarations
    )
  }

  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    const result = createEmptyInspectionResult()

    for (const part of typeNode.types) {
      mergeInspectionResult(
        result,
        inspectTypeNode(
          part,
          namespaceKey,
          fullPath,
          declarations,
          supportedEnvTargets,
          names,
          visitedDeclarations
        )
      )
    }

    return result
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const declaration = resolveDeclaration(declarations, getEntityNameText(typeNode.typeName), namespaceKey)
    return declaration
      ? inspectDeclaration(declaration, fullPath, declarations, supportedEnvTargets, names, visitedDeclarations)
      : createEmptyInspectionResult()
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
      return createEmptyInspectionResult()
    }

    const property = getInterfaceProperty(declaration.node, typeNode.indexType.literal.text)
    return property
      ? inspectProperty(
        property,
        declaration.namespaceKey,
        fullPath,
        declarations,
        supportedEnvTargets,
        names,
        visitedDeclarations
      )
      : createEmptyInspectionResult()
  }

  return createEmptyInspectionResult()
}

/**
 * @param {string} filePath
 * @param {SupportedConfigurationInfo} supportedConfigurationInfo
 * @returns {Set<string>}
 */
function getIndexDtsConfigurationNames (filePath, supportedConfigurationInfo) {
  const cacheKey = `${filePath}::${JSON.stringify([...supportedConfigurationInfo.envTargets.keys()].sort())}`
  const cachedNames = indexDtsConfigurationNamesCache.get(cacheKey)
  if (cachedNames) return cachedNames

  const sourceFile = ts.createSourceFile(filePath, readFile(filePath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = getDeclarationRegistry(sourceFile)
  const tracerOptions = declarations.get('tracer.TracerOptions')

  if (!tracerOptions || !ts.isInterfaceDeclaration(tracerOptions.node)) {
    throw new Error('Could not resolve tracer.TracerOptions.')
  }

  const names = new Set()
  inspectMembers(
    tracerOptions.node.members,
    tracerOptions.namespaceKey,
    '',
    declarations,
    supportedConfigurationInfo.envTargets,
    names,
    new Set()
  )

  for (const ignoredConfigurationName of IGNORED_CONFIGURATION_NAMES) {
    names.delete(ignoredConfigurationName)
  }

  indexDtsConfigurationNamesCache.set(cacheKey, names)
  return names
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

        const missingInIndexDts = [...supportedConfigurationInfo.names]
          .filter(name => !indexDtsNames.has(name))
          .sort()
        const missingInSupportedConfigurations = [...indexDtsNames]
          .filter(name => !supportedConfigurationInfo.names.has(name))
          .sort()

        for (const configurationName of missingInIndexDts) {
          context.report({
            node,
            messageId: 'configurationMissingInIndexDts',
            data: { configurationName },
          })
        }

        for (const configurationName of missingInSupportedConfigurations) {
          context.report({
            node,
            messageId: 'configurationMissingInSupportedConfigurations',
            data: { configurationName },
          })
        }
      },
    }
  },
}
