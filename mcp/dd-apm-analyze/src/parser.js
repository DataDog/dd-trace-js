'use strict'

const fs = require('fs/promises')
const path = require('path')
const parser = require('@babel/parser')
const traverse = require('@babel/traverse').default
const resolve = require('resolve')
const pacote = require('pacote')

// Broader set of common method names across different types of Node.js libraries
const COMMON_METHOD_NAMES = [
  // HTTP/Web related
  'handle', 'use', 'route', 'get', 'post', 'put', 'delete', 'patch', 'all', 'listen',
  'request', 'connect', 'send', 'json', 'jsonp', 'render', 'redirect', 'status',

  // Database related
  'query', 'execute', 'find', 'insert', 'update', 'delete', 'create', 'read',
  'findOne', 'findMany', 'save', 'remove', 'connect', 'disconnect',

  // Message queue related
  'publish', 'subscribe', 'consume', 'acknowledge', 'reject', 'sendMessage',

  // File system related
  'read', 'write', 'createReadStream', 'createWriteStream', 'stat', 'unlink',

  // Network related
  'connect', 'disconnect', 'bind', 'listen', 'accept', 'close',

  // Generic async operations
  'run', 'call', 'invoke', 'process', 'transform', 'validate'
]

// Domain-specific important methods that should be surfaced even without alias mapping
const IMPORTANT_CLASS_NAME_REGEX = /(Client|Cluster|Sentinel)$/i
const IMPORTANT_METHOD_NAMES = new Set(['connect', 'disconnect', 'sendCommand', 'publish', 'subscribe', 'multi', 'pipeline'])

async function analyzePackage (directory) {
  const pkgJsonPath = path.join(directory, 'package.json')
  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
  const entryPoint = path.join(directory, pkgJson.main || 'index.js')

  const analysisContext = {
    directory,
    targets: new Map(),
    visitedFiles: new Set(),
    externalCacheDir: path.join(directory, '.ddapm-ext-cache'),
    externalFetches: 0,
    externalFetchLimit: pkgJson.name?.startsWith('@') ? 6 : 3, // Higher limit for scoped packages
    externalMap: new Map(),
    externalMapPath: path.join(directory, '.ddapm-ext-cache', 'external-map.json'),
    // NEW: Package metadata for smart dependency resolution
    mainPackageName: pkgJson.name,
    mainPackageScope: pkgJson.name?.startsWith('@') ? pkgJson.name.split('/')[0] : null,
    peerDependencies: Object.keys(pkgJson.peerDependencies || {})
  }

  try { await fs.mkdir(analysisContext.externalCacheDir, { recursive: true }) } catch {}
  // Load existing external map if present
  try {
    const raw = await fs.readFile(analysisContext.externalMapPath, 'utf8')
    const obj = JSON.parse(raw)
    for (const [k, v] of Object.entries(obj)) analysisContext.externalMap.set(k, v)
  } catch {}

  await analyzeFile(entryPoint, 'default', analysisContext)

  const allTargets = Array.from(analysisContext.targets.values())
  return allTargets.sort((a, b) => b.confidence_score - a.confidence_score)
}

async function analyzeFile (filePath, exportPath, context) {
  if (context.visitedFiles.has(filePath)) return
  context.visitedFiles.add(filePath)

  console.log(`\nAnalyzing: ${path.relative(context.directory, filePath)}`)

  try {
    const code = await fs.readFile(filePath, 'utf8')
    const ast = parser.parse(code, { sourceType: 'unambiguous' })

    console.log(`  - File parsed successfully, ${code.length} characters`)

    const localRequires = new Map()
    const localFunctionIds = new Set()
    const pendingRequires = []
    const aliasMap = new Map()
    const exportsInfo = []
    const localClasses = new Map() // className -> Set(methodNames)
    let moduleExportsVar = null

    // Pass 1: Find all exports, local requires/imports, and local class declarations
    traverse(ast, {
      ImportDeclaration (p) {
        const { source, specifiers } = p.node
        const src = source && source.value
        if (!src) return
        // Map imported identifiers to current exportPath (namespace not fully resolved, but enables structural inclusion)
        for (const s of specifiers) {
          const local = s.local && s.local.name
          if (!local) continue
          aliasMap.set(local, exportPath)
        }
        pendingRequires.push({ source: src, nextExportPath: exportPath })
      },
      VariableDeclarator (p) {
        const { id, init } = p.node
        if (init && init.type === 'CallExpression' && init.callee.name === 'require' && id?.name) {
          localRequires.set(id.name, init.arguments[0].value)
        }
        // const foo = function () {} or const foo = () => {}
        if (id?.name && init && (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')) {
          localFunctionIds.add(id.name)
        }
        // Detect chained assignments like: var app = exports = module.exports = {...}
        if (id?.name && init && init.type === 'AssignmentExpression') {
          if (containsModuleExports(init)) {
            moduleExportsVar = id.name
            aliasMap.set(id.name, exportPath)
          }
        }
      },
      FunctionDeclaration (p) {
        const fn = p.node
        if (fn.id && fn.id.name) localFunctionIds.add(fn.id.name)
      },
      ClassDeclaration (p) {
        const cls = p.node
        if (!cls.id || !cls.body || !cls.body.body) return
        const className = cls.id.name
        const methods = new Set()
        for (const elt of cls.body.body) {
          if ((elt.type === 'ClassMethod' || elt.type === 'MethodDefinition') && elt.key) {
            const name = elt.key.name || elt.key.value
            if (name) methods.add(String(name))
          }
        }
        if (methods.size) localClasses.set(className, methods)
      },
      AssignmentExpression (p) {
        const { left, right } = p.node

        // Detect module.exports = Identifier; record Identifier as export var
        if (
          left.type === 'MemberExpression' &&
          left.object.type === 'Identifier' && left.object.name === 'module' &&
          left.property.type === 'Identifier' && left.property.name === 'exports' &&
          right.type === 'Identifier'
        ) {
          moduleExportsVar = right.name
          aliasMap.set(right.name, exportPath)
        }

        // Track all exports
        if (left.type === 'MemberExpression' &&
            left.object.type === 'Identifier' && left.object.name === 'module' &&
            left.property.type === 'Identifier' && left.property.name === 'exports') {
          exportsInfo.push({ type: 'module.exports', value: right })
          if (right.type === 'Identifier') {
            aliasMap.set(right.name, exportPath)
          }
          // If RHS is a function or class, treat aliasing as export root
          if (right.type === 'FunctionExpression' || right.type === 'ArrowFunctionExpression' || right.type === 'ClassExpression') {
            // nothing extra; Pass 6 will handle factory/class details
          }
        }

        if (left.type === 'MemberExpression' &&
            left.object.type === 'Identifier' && left.object.name === 'exports') {
          exportsInfo.push({
            type: 'exports.property',
            property: left.property.name,
            value: right
          })
          if (right.type === 'Identifier') {
            const propPath = exportPath === 'default' ? left.property.name : `${exportPath}.${left.property.name}`
            aliasMap.set(right.name, propPath)

            // If this is a local variable that was assigned from a require, enqueue it
            if (localRequires.has(right.name)) {
              const src = localRequires.get(right.name)
              pendingRequires.push({ source: src, nextExportPath: propPath })
            }
          }
        }

        // Enqueue requires for recursion
        if (right.type === 'CallExpression' && right.callee.name === 'require') {
          const src = right.arguments[0]?.value
          if (typeof src === 'string') {
            let nextExportPath = exportPath
            if (left.type === 'MemberExpression' &&
                left.object.type === 'Identifier' && left.object.name === 'exports') {
              nextExportPath = exportPath === 'default' ? left.property.name : `${exportPath}.${left.property.name}`
            }
            pendingRequires.push({ source: src, nextExportPath })
          }
        }

        // Also track when local variables are assigned to requires (for later export)
        if (right.type === 'CallExpression' && right.callee.name === 'require' &&
            left.type === 'Identifier') {
          const varName = left.name
          const src = right.arguments[0]?.value
          if (typeof src === 'string') {
            localRequires.set(varName, src)
          }
        }
      },
      ExportNamedDeclaration (p) {
        const { declaration, specifiers, source } = p.node
        if (declaration) {
          // export class Foo {} or export function bar() {}
          if ((declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration') && declaration.id) {
            const name = declaration.id.name
            aliasMap.set(name, exportPath)
            if (declaration.type === 'FunctionDeclaration') {
              // Directly exported named function: record as target
              maybeRecordTarget(context, exportPath, name, filePath, true)
            }
          }
          if (declaration.type === 'VariableDeclaration') {
            for (const d of declaration.declarations) {
              if (d.id && d.id.name) aliasMap.set(d.id.name, exportPath)
              // export const foo = () => {}
              if (d.id && d.id.name && d.init && (d.init.type === 'FunctionExpression' || d.init.type === 'ArrowFunctionExpression')) {
                maybeRecordTarget(context, exportPath, d.id.name, filePath, true)
              }
            }
          }
        } else if (specifiers && specifiers.length) {
          // export { Foo as Bar } from './mod'
          const src = source && source.value
          if (src) pendingRequires.push({ source: src, nextExportPath: exportPath })
          for (const s of specifiers) {
            const local = s.local && s.local.name
            const exported = s.exported && s.exported.name
            if (local) aliasMap.set(local, exportPath)
            if (exported) aliasMap.set(exported, exportPath)
          }
        }
      },
      ExportAllDeclaration (p) {
        const src = p.node.source && p.node.source.value
        if (src) {
          pendingRequires.push({ source: src, nextExportPath: exportPath })
        }
      },
      ExportDefaultDeclaration (p) {
        const decl = p.node.declaration
        if (!decl) return
        if (decl.type === 'Identifier') {
          aliasMap.set(decl.name, exportPath)
        } else if (decl.type === 'FunctionDeclaration' && decl.id && decl.id.name) {
          aliasMap.set(decl.id.name, exportPath)
          maybeRecordTarget(context, exportPath, decl.id.name, filePath, true)
        } else if (decl.type === 'ClassDeclaration' && decl.id) {
          aliasMap.set(decl.id.name, exportPath)
          // collect methods for this class
          const methods = new Set()
          for (const elt of (decl.body && decl.body.body) || []) {
            if ((elt.type === 'ClassMethod' || elt.type === 'MethodDefinition') && elt.key) {
              const name = elt.key.name || elt.key.value
              if (name) methods.add(String(name))
            }
          }
          if (methods.size) localClasses.set(decl.id.name, methods)
        } else if (decl.type === 'CallExpression' || decl.type === 'FunctionExpression' || decl.type === 'ArrowFunctionExpression') {
          // handled by factory-return pass
        }
      }
    })

    // Pass 2: Find method assignments
    traverse(ast, {
      AssignmentExpression (p) {
        const { left, right } = p.node
        if (left.type !== 'MemberExpression') return

        const objectName = getObjectPath(left.object)
        const methodName = left.property && left.property.name
        if (!methodName) return

        // Case A: exports.foo = function() {} (or arrow)
        if (right.type === 'FunctionExpression' || right.type === 'ArrowFunctionExpression') {
          console.log(`  - Found assignment: ${objectName}.${methodName} = function`)
          const decision = shouldIncludeMethod(methodName, objectName, aliasMap, localRequires, moduleExportsVar)
          if (decision.include) {
            console.log(`    -> Method included: ${methodName}`)
            let exportPathForMethod = determineExportPath(objectName, aliasMap, localRequires, exportPath)
            const root = objectName.split('.')[0]
            if (moduleExportsVar && root === moduleExportsVar) {
              exportPathForMethod = exportPath
            }
            console.log(`    -> Export path: ${exportPathForMethod}`)
            maybeRecordTarget(context, exportPathForMethod, methodName, filePath, decision.structural)
          } else {
            console.log(`    -> Method excluded: ${methodName}`)
          }
          return
        }

        // Case B: exports.foo = foo; where local function foo exists
        if (right.type === 'Identifier' && localFunctionIds.has(right.name)) {
          const decision = shouldIncludeMethod(methodName, objectName, aliasMap, localRequires, moduleExportsVar)
          if (decision.include) {
            let exportPathForMethod = determineExportPath(objectName, aliasMap, localRequires, exportPath)
            const root = objectName.split('.')[0]
            if (moduleExportsVar && root === moduleExportsVar) {
              exportPathForMethod = exportPath
            }
            maybeRecordTarget(context, exportPathForMethod, methodName, filePath, true)
          }
        }
      }
    })

    // Pass 2b: Detect mixin / Object.assign patterns to propagate alias mapping
    traverse(ast, {
      CallExpression (p) {
        const { callee, arguments: args } = p.node
        if (!args || args.length < 2) return
        // mixin(targetId, sourceId, ...)
        if (callee.type === 'Identifier' && callee.name === 'mixin') {
          if (args[0].type === 'Identifier' && args[1].type === 'Identifier') {
            const targetId = args[0].name
            const sourceId = args[1].name
            const targetPath = aliasMap.get(targetId)
            if (targetPath) {
              aliasMap.set(sourceId, targetPath)
            }
          }
        }
        // Object.assign(targetId, sourceId, ...)
        if (callee.type === 'MemberExpression' && callee.object.name === 'Object' && callee.property.name === 'assign') {
          if (args[0].type === 'Identifier' && args[1] && args[1].type === 'Identifier') {
            const targetId = args[0].name
            const sourceId = args[1].name
            const targetPath = aliasMap.get(targetId)
            if (targetPath) {
              aliasMap.set(sourceId, targetPath)
            }
          }
          // Handle re-export pattern: Object.assign(module.exports, require('./x')) or Object.assign(exports, require('./x'))
          const target = args[0]
          const source = args[1]
          const isExportsTarget = target && (
            (target.type === 'MemberExpression' && target.object.type === 'Identifier' && target.object.name === 'module' && target.property.name === 'exports') ||
            (target.type === 'Identifier' && target.name === 'exports')
          )
          const isRequireSource = source && source.type === 'CallExpression' && source.callee.name === 'require' && source.arguments[0] && typeof source.arguments[0].value === 'string'
          if (isExportsTarget && isRequireSource) {
            const src = source.arguments[0].value
            pendingRequires.push({ source: src, nextExportPath: exportPath })
          }
        }

        // Handle TS/CJS re-export: __exportStar(require('./x'), exports) or tslib.__exportStar(...)
        if (
          (callee.type === 'Identifier' && callee.name === '__exportStar') ||
          (callee.type === 'MemberExpression' && callee.property && callee.property.name === '__exportStar')
        ) {
          const srcArg = args[0]
          const tgtArg = args[1]
          const isExportsTarget = tgtArg && ((tgtArg.type === 'Identifier' && tgtArg.name === 'exports') ||
            (tgtArg.type === 'MemberExpression' && tgtArg.object.type === 'Identifier' && tgtArg.object.name === 'module' && tgtArg.property.name === 'exports'))
          const isRequireSource = srcArg && srcArg.type === 'CallExpression' && srcArg.callee.name === 'require' && srcArg.arguments[0] && typeof srcArg.arguments[0].value === 'string'
          if (isExportsTarget && isRequireSource) {
            const src = srcArg.arguments[0].value
            pendingRequires.push({ source: src, nextExportPath: exportPath })
          }
        }

        // Handle Object.defineProperty(exports, 'name', { get: function(){ return id.name } })
        if (callee.type === 'MemberExpression' && callee.object.name === 'Object' && callee.property.name === 'defineProperty') {
          const [target, prop, descriptor] = args
          const isExportsTarget = target && ((target.type === 'Identifier' && target.name === 'exports') ||
            (target.type === 'MemberExpression' && target.object.type === 'Identifier' && target.object.name === 'module' && target.property.name === 'exports'))
          if (isExportsTarget && prop && prop.type === 'StringLiteral' && descriptor && descriptor.type === 'ObjectExpression') {
            const propName = prop.value
            const getProp = descriptor.properties.find(p => p.key && p.key.name === 'get')
            if (getProp && getProp.value && (getProp.value.type === 'FunctionExpression' || getProp.value.type === 'ArrowFunctionExpression')) {
              const body = getProp.value.body
              let retExpr = null
              if (body.type === 'BlockStatement') {
                const ret = body.body.find(s => s.type === 'ReturnStatement' && s.argument)
                retExpr = ret && ret.argument
              } else {
                retExpr = body
              }
              if (retExpr && retExpr.type === 'MemberExpression' && retExpr.object && retExpr.object.type === 'Identifier') {
                const id = retExpr.object.name
                if (localRequires.has(id)) {
                  const src = localRequires.get(id)
                  const nextExportPath = exportPath === 'default' ? propName : `${exportPath}.${propName}`
                  pendingRequires.push({ source: src, nextExportPath })
                }
              }
            }
          }
        }
      }
    })

    // Pass 3: Collect methods on any identifier that we have mapped as an export alias (structural)
    if (aliasMap.size > 0) {
      traverse(ast, {
        AssignmentExpression (p) {
          const { left, right } = p.node
          if (left.type !== 'MemberExpression' ||
              (right.type !== 'FunctionExpression' && right.type !== 'ArrowFunctionExpression')) return
          const objPath = getObjectPath(left.object)
          const root = objPath.split('.')[0]
          const methodName = left.property.name
          if (aliasMap.has(root)) {
            const base = aliasMap.get(root)
            const remainder = objPath.length > root.length ? objPath.substring(root.length + 1) : ''
            const exportName = remainder ? `${base}.${remainder}` : base
            maybeRecordTarget(context, exportName, methodName, filePath, true)
          }
        }
      })
    }

    // Pass 3b: Enqueue dynamic requires inside functions when they look like core entrypoints
    traverse(ast, {
      CallExpression (p) {
        const { callee, arguments: args } = p.node
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'require') return
        const spec = args && args[0] && args[0].value
        if (typeof spec !== 'string') return
        if (/(client|cluster|sentinel)/i.test(spec)) {
          pendingRequires.push({ source: spec, nextExportPath: exportPath })
        }
      }
    })

    // Pass 4: Class and prototype methods mapped via export aliases
    traverse(ast, {
      ClassDeclaration (p) {
        const cls = p.node
        if (!cls.id || !cls.body || !cls.body.body) return
        const className = cls.id.name
        const mapped = aliasMap.get(className)
        if (!mapped) return
        for (const elt of cls.body.body) {
          if (elt.type === 'ClassMethod' || elt.type === 'ClassPrivateMethod' || elt.type === 'MethodDefinition') {
            const key = elt.key
            const name = key && (key.name || key.value)
            if (!name) continue
            maybeRecordTarget(context, mapped, String(name), filePath, true)
          }
        }
      }
    })

    // Pass 5: Prototype assignment pattern: Identifier.prototype.method = function
    traverse(ast, {
      AssignmentExpression (p) {
        const { left, right } = p.node
        if (left.type !== 'MemberExpression' ||
            (right.type !== 'FunctionExpression' && right.type !== 'ArrowFunctionExpression')) return
        // Detect A.prototype or A.prototype.something chains
        const obj = left.object
        if (obj.type === 'MemberExpression' && obj.property && obj.property.name === 'prototype') {
          const root = obj.object.type === 'Identifier' ? obj.object.name : null
          if (!root) return
          const methodName = left.property && left.property.name
          if (!methodName) return
          const mapped = aliasMap.get(root)
          if (mapped) {
            maybeRecordTarget(context, mapped, methodName, filePath, true)
            return
          }
          // Heuristic: treat important methods on *Client/*Cluster/*Sentinel as part of default export
          if (IMPORTANT_CLASS_NAME_REGEX.test(root) && IMPORTANT_METHOD_NAMES.has(methodName)) {
            maybeRecordTarget(context, exportPath, methodName, filePath, true)
          }
        }
      }
    })

    // Pass 6: Factory-return patterns on exported functions and class identifier exports
    traverse(ast, {
      AssignmentExpression (p) {
        const { left, right } = p.node
        // Left must bind to an export path (module.exports, exports.prop, or aliasMap root)
        let exportBase = null
        if (left.type === 'MemberExpression' && left.object.type === 'Identifier' && left.object.name === 'module' && left.property.name === 'exports') {
          exportBase = exportPath
        } else if (left.type === 'MemberExpression' && left.object.type === 'Identifier' && left.object.name === 'exports') {
          exportBase = exportPath === 'default' ? left.property.name : `${exportPath}.${left.property.name}`
        } else if (left.type === 'Identifier' && aliasMap.has(left.name)) {
          exportBase = aliasMap.get(left.name)
        }

        if (!exportBase) return

        // Right side is a factory function that returns an object literal
        // If the RHS is a Class identifier or literal and we know its methods, emit them
        if (right.type === 'Identifier' && localClasses.has(right.name)) {
          for (const m of localClasses.get(right.name)) {
            maybeRecordTarget(context, exportBase, String(m), filePath, true)
          }
          return
        }

        const fn = (right.type === 'FunctionExpression' || right.type === 'ArrowFunctionExpression') ? right : null
        if (!fn || !fn.body) return
        let returnedObj = null
        if (fn.body.type === 'ObjectExpression') {
          returnedObj = fn.body
        } else if (fn.body.type === 'BlockStatement') {
          for (const stmt of fn.body.body) {
            if (stmt.type === 'ReturnStatement' && stmt.argument && stmt.argument.type === 'ObjectExpression') {
              returnedObj = stmt.argument
              break
            }
          }
        }
        if (!returnedObj) return
        for (const prop of returnedObj.properties) {
          if (prop.type !== 'ObjectProperty') continue
          const key = prop.key
          const name = key && (key.name || key.value)
          if (!name) continue
          const val = prop.value
          if (val.type === 'FunctionExpression' || val.type === 'ArrowFunctionExpression') {
            maybeRecordTarget(context, exportBase, String(name), filePath, true)
          }
        }
      }
    })

    // Additional check for the Express pattern: assignments to exported objects
    // Look for patterns like: app.handle = function() where app = exports = module.exports
    if (moduleExportsVar) {
      traverse(ast, {
        AssignmentExpression (p) {
          const { left, right } = p.node
          if (left.type !== 'MemberExpression' || right.type !== 'FunctionExpression') return

          const objectName = left.object.name
          const methodName = left.property.name

          // Check if this object is the module.exports variable alias
          if (objectName === moduleExportsVar) {
            console.log(`  - Found export method: ${objectName}.${methodName} = function`)
            // Structural match on main export
            maybeRecordTarget(context, exportPath, methodName, filePath, true)
          }
        }
      })
    }

    // Recurse into required files
    // Also include locally required external modules (e.g., 'graphql') to surface core APIs
    try {
      for (const [_, src] of localRequires) {
        if (shouldFetchExternal(src, context)) {
          pendingRequires.push({ source: src, nextExportPath: src })
        }
      }
    } catch {}

    for (const { source, nextExportPath } of pendingRequires) {
      try {
        const resolved = resolve.sync(source, { basedir: path.dirname(filePath) })
        console.log(`  - Recursing into: ${source} -> ${resolved} (exportPath: ${nextExportPath})`)
        // Allow recursion if the resolved path stays within the extracted package directory
        const relToRoot = path.relative(context.directory, resolved)
        const withinRoot = !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)
        if (withinRoot) {
          await analyzeFile(resolved, nextExportPath, context)
        } else {
          console.log(`  - Skipping external file: ${resolved}`)
        }
      } catch (e) {
        console.log(`  - Failed to resolve ${source}: ${e.message}`)
        // Try fetching related external packages (same-scope or peer dependencies)
        if (shouldFetchExternal(source, context)) {
          const entry = await fetchExternalEntry(source, context)
          if (entry) {
            context.externalFetches++
            console.log(`  - Analyzing fetched external: ${source} -> ${entry}`)
            await analyzeFile(entry, nextExportPath, context)
          }
        }
      }
    }
  } catch { /* ignore */ }
}

function shouldIncludeMethod (methodName, objectName, aliasMap, localRequires, moduleExportsVar) {
  // Structural signals
  const rootObject = objectName.split('.')[0]
  if (moduleExportsVar && rootObject === moduleExportsVar) {
    return { include: true, structural: true }
  }

  // Include if it's a common method name
  if (COMMON_METHOD_NAMES.includes(methodName.toLowerCase())) {
    return { include: true, structural: false }
  }

  // Include if it's on an aliased export
  if (aliasMap.has(rootObject)) {
    return { include: true, structural: true }
  }

  // Include if it's on a locally required module
  if (localRequires.has(rootObject)) {
    return { include: true, structural: false }
  }

  // Include if it's a direct assignment to exports or module.exports
  if (objectName.startsWith('exports.') || objectName === 'exports' ||
      objectName.startsWith('module.exports') || objectName === 'module.exports') {
    return { include: true, structural: true }
  }

  return { include: false, structural: false }
}

function determineExportPath (objectName, aliasMap, localRequires, currentExportPath) {
  const rootObject = objectName.split('.')[0]

  // Check aliases first
  if (aliasMap.has(rootObject)) {
    return aliasMap.get(rootObject)
  }

  // Check local requires
  if (localRequires.has(rootObject)) {
    const reqPath = localRequires.get(rootObject)
    const remainder = objectName.substring(rootObject.length + 1)
    return remainder ? `${reqPath}.${remainder}` : reqPath
  }

  // Handle direct exports
  if (objectName === 'exports') {
    return currentExportPath
  }
  if (objectName.startsWith('exports.')) {
    const prop = objectName.substring('exports.'.length)
    return currentExportPath === 'default' ? prop : `${currentExportPath}.${prop}`
  }

  if (objectName === 'module.exports') {
    return currentExportPath
  }
  if (objectName.startsWith('module.exports.')) {
    const sub = objectName.substring('module.exports.'.length)
    return sub ? `${currentExportPath}.${sub}` : currentExportPath
  }

  // Default fallback
  return currentExportPath
}

function maybeRecordTarget (context, exportName, methodName, filePath, structural = false) {
  let score = calculateScore(methodName)
  if (structural && score === 0) {
    // Assign a minimal score for structural matches on exported objects
    score = 0.5
  }
  console.log(`    -> Recording target: ${exportName}.${methodName} (score: ${score})`)

  if (score <= 0) {
    console.log('    -> Skipping due to low score')
    return
  }

  const key = `${exportName}.${methodName}`
  if (context.targets.has(key)) {
    console.log('    -> Skipping duplicate target')
    return
  }

  console.log('    -> Adding target to results')
  context.targets.set(key, {
    export_name: exportName,
    function_name: methodName,
    type: 'method',
    file_path: path.relative(context.directory, filePath),
    confidence_score: score,
    reasoning: `Found method '${methodName}' on exported object '${exportName}'.`
  })
}

function getObjectPath (node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') {
    return `${getObjectPath(node.object)}.${node.property.name}`
  }
  return ''
}

function calculateScore (methodName) {
  const index = COMMON_METHOD_NAMES.indexOf(methodName.toLowerCase())
  if (index === -1) return 0
  // Higher score for methods that appear earlier in the list
  return parseFloat((1 - (index / COMMON_METHOD_NAMES.length)).toFixed(2))
}

function isBareSpecifier (spec) {
  return typeof spec === 'string' && !spec.startsWith('.') && !spec.startsWith('/')
}

function shouldFetchExternal (spec, context) {
  if (!isBareSpecifier(spec)) return false
  if (context.externalFetches >= context.externalFetchLimit) return false

  // Same-scope packages (e.g., @clickhouse/client -> @clickhouse/client-common)
  if (context.mainPackageScope && spec.startsWith(context.mainPackageScope + '/')) {
    console.log(`  - Will fetch same-scope dependency: ${spec}`)
    return true
  }

  // Peer dependencies (explicitly declared as important)
  if (context.peerDependencies.includes(spec)) {
    console.log(`  - Will fetch peer dependency: ${spec}`)
    return true
  }

  return false
}

async function fetchExternalEntry (pkgIdentifier, cacheRoot) {
  try {
    const safeName = pkgIdentifier.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const outDir = path.join(cacheRoot.externalCacheDir || cacheRoot, safeName)
    await pacote.extract(pkgIdentifier, outDir)
    // Record mapping
    if (cacheRoot.externalMap) {
      cacheRoot.externalMap.set(safeName, pkgIdentifier)
      try {
        const obj = Object.fromEntries(cacheRoot.externalMap)
        await fs.writeFile(cacheRoot.externalMapPath, JSON.stringify(obj, null, 2))
      } catch {}
    }
    const pkgJsonPath = path.join(outDir, 'package.json')
    const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
    let entry = pkg.main || pkg.module || 'index.js'
    entry = path.isAbsolute(entry) ? entry : path.join(outDir, entry)
    return entry
  } catch {
    return null
  }
}

// Detect whether an AssignmentExpression chain includes module.exports or exports
function containsModuleExports (assignExpr) {
  let current = assignExpr
  const seen = new Set()
  while (current && current.type === 'AssignmentExpression' && !seen.has(current)) {
    seen.add(current)
    const left = current.left
    if (
      left.type === 'MemberExpression' &&
      left.object.type === 'Identifier' &&
      (
        (left.object.name === 'module' && left.property.type === 'Identifier' && left.property.name === 'exports') ||
        (left.object.name === 'exports')
      )
    ) {
      return true
    }
    current = current.right
  }
  return false
}

module.exports = { analyzePackage }
