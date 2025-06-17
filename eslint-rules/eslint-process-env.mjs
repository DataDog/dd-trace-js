export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow usage of process.env outside config-helper.js'
    },
    schema: []
  },
  create (context) {
    const isProcessEnvObject = (node) => {
      return node?.type === 'MemberExpression' &&
             node.object?.name === 'process' &&
             node.property?.name === 'env'
    }

    const report = (node) => {
      context.report({
        node,
        message: 'Usage of process.env is only allowed in config-helper.js'
      })
    }

    return {
      // Handle direct member expressions: process.env.FOO
      MemberExpression (node) {
        // direct `process.env` or nested `process.env.FOO`
        if (isProcessEnvObject(node) ||
            node.object?.type === 'MemberExpression' && isProcessEnvObject(node.object)) {
          report(node)
        }
      },

      // Handle destructuring: const { FOO } = process.env
      VariableDeclarator (node) {
        if (
          node.init?.type === 'MemberExpression' &&
          isProcessEnvObject(node.init) &&
          node.id.type === 'Identifier'
        ) {
          // const env = process.env
          report(node)
        } else if (
          node.init?.type === 'Identifier' &&
          node.init.name === 'process' &&
          node.id.type === 'ObjectPattern'
        ) {
          // const { env } = process
          for (const prop of node.id.properties) {
            if (prop.type === 'Property' && prop.key.name === 'env') {
              report(node)
              break
            }
          }
        }
        // const { FOO } = process.env
        if (
          node.init?.type === 'MemberExpression' &&
          isProcessEnvObject(node.init)
        ) {
          report(node)
        }
      },

      // Spread usage: { ...process.env } or { ...envAlias }
      SpreadElement (node) {
        if (isProcessEnvObject(node.argument)) {
          report(node)
        }
      },

      // Any function call receiving process.env
      CallExpression (node) {
        for (const arg of node.arguments) {
          if (isProcessEnvObject(arg)) {
            report(node)
            break
          }
        }
      }
    }
  }
}
