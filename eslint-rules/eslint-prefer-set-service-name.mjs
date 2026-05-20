const SERVICE_KEYS = new Set(['service', 'service.name'])
// Constants exported by `ext/tags.js` / wrapper code that resolve to a service key.
// Catching these by name handles `setTag(SERVICE_NAME, x)` and `addTags({ [SERVICE_NAME]: x })`.
const SERVICE_KEY_IDENTIFIERS = new Set(['SERVICE_NAME', 'SERVICE_KEY'])

function describeServiceKey (node) {
  if (!node) return undefined
  if (node.type === 'Literal') {
    return typeof node.value === 'string' && SERVICE_KEYS.has(node.value) ? node.value : undefined
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    const value = node.quasis[0].value.cooked
    return SERVICE_KEYS.has(value) ? value : undefined
  }
  if (node.type === 'Identifier' && SERVICE_KEY_IDENTIFIERS.has(node.name)) {
    return node.name
  }
  return undefined
}

function describeStaticPropertyKey (property) {
  if (property.computed) {
    return describeServiceKey(property.key)
  }
  if (property.key.type === 'Identifier' && SERVICE_KEYS.has(property.key.name)) {
    return property.key.name
  }
  if (property.key.type === 'Literal' && SERVICE_KEYS.has(property.key.value)) {
    return property.key.value
  }
  return undefined
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid integration code from writing the `service`/`service.name` tag directly via ' +
        '`setTag`/`addTags`. Use `Plugin#setServiceName(span, name)` so the integration\'s ' +
        'intended service is recorded and user overrides are detected at finish time.',
    },
    schema: [],
    messages: {
      preferSetServiceName:
        'Use `setServiceName(span, name, tracerService)` from ' +
        '`service-naming/source-marker` instead of writing `{{key}}` via `{{method}}` directly. ' +
        'Direct writes bypass integration-source tracking and make user overrides ' +
        'indistinguishable from integration values.',
    },
  },

  create (context) {
    return {
      CallExpression (node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.computed) return

        const method = callee.property.name
        if (method !== 'setTag' && method !== 'addTags') return

        if (method === 'setTag') {
          const key = describeServiceKey(node.arguments[0])
          if (key !== undefined) {
            context.report({ node, messageId: 'preferSetServiceName', data: { key, method } })
          }
          return
        }

        const arg = node.arguments[0]
        if (!arg || arg.type !== 'ObjectExpression') return
        for (const prop of arg.properties) {
          if (prop.type !== 'Property') continue
          const key = describeStaticPropertyKey(prop)
          if (key === undefined) continue
          context.report({ node: prop, messageId: 'preferSetServiceName', data: { key, method } })
        }
      },
    }
  },
}
