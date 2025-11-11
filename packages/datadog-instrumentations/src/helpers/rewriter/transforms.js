'use strict'

const tracingChannelPredicate = (node) => (
  node.specifiers?.[0]?.local?.name === 'tr_ch_apm_tracingChannel' ||
    node.declarations?.[0]?.id?.properties?.[0]?.value?.name === 'tr_ch_apm_tracingChannel'
)

const transforms = module.exports = {
  tracingChannelImport ({ format }, node) {
    if (node.body.some(tracingChannelPredicate)) return

    const index = node.body.findIndex(child => child.directive === 'use strict')

    if (format === 'module') {
      node.body.splice(index + 1, 0, {
        type: 'ImportDeclaration',
        specifiers: [
          {
            type: 'ImportSpecifier',
            local: { type: 'Identifier', name: 'tr_ch_apm_tracingChannel' },
            imported: { type: 'Identifier', name: 'tracingChannel' }
          }
        ],
        source: { type: 'Literal', value: 'diagnostics_channel' },
        attributes: []
      })
    } else {
      node.body.splice(index + 1, 0, {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: {
              type: 'ObjectPattern',
              properties: [
                {
                  type: 'Property',
                  key: { type: 'Identifier', name: 'tracingChannel' },
                  value: {
                    type: 'Identifier',
                    name: 'tr_ch_apm_tracingChannel'
                  },
                  kind: 'init',
                  computed: false,
                  method: false,
                  shorthand: false
                }
              ]
            },
            init: {
              type: 'CallExpression',
              callee: { type: 'Identifier', name: 'require' },
              arguments: [{ type: 'Literal', value: 'diagnostics_channel' }],
              optional: false
            }
          }
        ]
      })
    }
  },

  tracingChannelDeclaration (state, node) {
    const { channelName, moduleName } = state
    const channelVariable = channelName.replaceAll(':', '_')

    transforms.tracingChannelImport(state, node)

    const index = node.body.findIndex(tracingChannelPredicate)

    node.body.splice(index + 1, 0, {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: { type: 'Identifier', name: `tr_ch_apm$${channelVariable}` },
          init: {
            type: 'CallExpression',
            callee: { type: 'Identifier', name: 'tr_ch_apm_tracingChannel' },
            arguments: [
              {
                type: 'Literal',
                value: `orchestrion:${moduleName}:${channelName}`
              }
            ],
            optional: false
          }
        }
      ]
    })
  },

  traceSync (state, node, parent, ancestry) {
    traceAny('traceSync', state, node, ancestry)
  },

  tracePromise (state, node, parent, ancestry) {
    traceAny('tracePromise', state, node, ancestry)
  }
}

function traceAny (operator, state, node, ancestry) {
  const { channelName, functionQuery } = state
  const { methodName } = functionQuery
  const channelVariable = channelName.replaceAll(':', '_')
  const program = ancestry[ancestry.length - 1]
  const async = operator === 'tracePromise'

  let field = 'body'

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    const classBody = node.body

    // If the method exists on the class, we return as it will be patched later
    // while traversing child nodes later on.
    if (classBody.body.some(({ key }) => key.name === methodName)) return

    // Method doesn't exist on the class so we assume an instance method and
    // wrap it in the constructor instead.
    let ctor = classBody.body.find(({ kind }) => kind === 'constructor')

    if (!ctor) {
      ctor = {
        type: 'MethodDefinition',
        kind: 'constructor',
        static: false,
        computed: false,
        key: { type: 'Identifier', name: 'constructor' },
        value: {
          type: 'FunctionExpression',
          params: [],
          body: { type: 'BlockStatement', body: [] },
          async: false,
          generator: false,
          id: null
        }
      }

      if (node.superClass) {
        ctor.value.body.params.push({
          type: 'RestElement',
          argument: { type: 'Identifier', name: 'args' }
        })

        ctor.value.body.body.push({
          type: 'ExpressionStatement',
          expression: {
            type: 'CallExpression',
            callee: { type: 'Super' },
            arguments: [
              {
                type: 'SpreadElement',
                argument: { type: 'Identifier', name: 'args' }
              }
            ],
            optional: false
          }
        })
      }

      classBody.body.unshift(ctor)
    }

    ctor.value.body.body.push({
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: { type: 'Identifier', name: methodName },
          init: {
            type: 'MemberExpression',
            object: { type: 'ThisExpression' },
            computed: false,
            property: { type: 'Identifier', name: methodName },
            optional: false
          }
        }
      ]
    },
    {
      type: 'ExpressionStatement',
      expression: {
        type: 'AssignmentExpression',
        left: {
          type: 'MemberExpression',
          object: { type: 'ThisExpression' },
          computed: false,
          property: { type: 'Identifier', name: methodName },
          optional: false
        },
        operator: '=',
        right: { type: 'Identifier', name: methodName }
      }
    })

    node = ctor.value
    field = 'right'
  }

  transforms.tracingChannelDeclaration(state, program)

  const body = node[field]

  node[field] = {
    type: 'BlockStatement',
    body: [
      {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: { type: 'Identifier', name: '__apm$original_args' },
            init: { type: 'Identifier', name: 'arguments' }
          }
        ]
      },
      {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: { type: 'Identifier', name: '__apm$traced' },
            init: {
              type: 'ArrowFunctionExpression',
              params: [],
              body: {
                type: 'BlockStatement',
                body: [
                  {
                    type: 'VariableDeclaration',
                    kind: 'const',
                    declarations: [
                      {
                        type: 'VariableDeclarator',
                        id: {
                          type: 'Identifier',
                          name: '__apm$wrapped'
                        },
                        init: {
                          type: 'ArrowFunctionExpression',
                          params: [],
                          body,
                          async,
                          expression: false,
                          generator: false
                        }
                      }
                    ]
                  },
                  {
                    type: 'ReturnStatement',
                    argument: {
                      type: 'CallExpression',
                      callee: {
                        type: 'MemberExpression',
                        object: {
                          type: 'Identifier',
                          name: '__apm$wrapped'
                        },
                        computed: false,
                        property: { type: 'Identifier', name: 'apply' },
                        optional: false
                      },
                      arguments: [
                        { type: 'Literal', value: null },
                        {
                          type: 'Identifier',
                          name: '__apm$original_args'
                        }
                      ],
                      optional: false
                    }
                  }
                ]
              },
              async,
              expression: false,
              generator: false
            }
          }
        ]
      },
      {
        type: 'IfStatement',
        test: {
          type: 'UnaryExpression',
          operator: '!',
          argument: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: `tr_ch_apm$${channelVariable}` },
            computed: false,
            property: { type: 'Identifier', name: 'hasSubscribers' },
            optional: false
          },
          prefix: true
        },
        consequent: {
          type: 'ReturnStatement',
          argument: {
            type: 'CallExpression',
            callee: { type: 'Identifier', name: '__apm$traced' },
            arguments: [],
            optional: false
          }
        },
        alternate: null
      },
      {
        type: 'ReturnStatement',
        argument: {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: `tr_ch_apm$${channelVariable}` },
            computed: false,
            property: { type: 'Identifier', name: operator },
            optional: false
          },
          arguments: [
            { type: 'Identifier', name: '__apm$traced' },
            {
              type: 'ObjectExpression',
              properties: [
                {
                  type: 'Property',
                  key: { type: 'Identifier', name: 'arguments' },
                  value: { type: 'Identifier', name: 'arguments' },
                  kind: 'init',
                  computed: false,
                  method: false,
                  shorthand: true
                },
                {
                  type: 'Property',
                  key: { type: 'Identifier', name: 'self' },
                  value: { type: 'ThisExpression' },
                  kind: 'init',
                  computed: false,
                  method: false,
                  shorthand: false
                },
                {
                  type: 'Property',
                  key: { type: 'Identifier', name: 'moduleVersion' },
                  value: { type: 'Literal', value: '1.0.0' },
                  kind: 'init',
                  computed: false,
                  method: false,
                  shorthand: false
                }
              ]
            }
          ],
          optional: false
        }
      }
    ]
  }
}
