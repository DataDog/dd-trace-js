module.exports = [
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.js"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:execute"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.mjs"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:execute"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "language/parser.js"
    },
    "functionQuery": {
      "functionName": "parse",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:parser"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "language/parser.mjs"
    },
    "functionQuery": {
      "functionName": "parse",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:parser"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "validation/validate.js"
    },
    "functionQuery": {
      "functionName": "validate",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:validate"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "validation/validate.mjs"
    },
    "functionQuery": {
      "functionName": "validate",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:validate"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.js"
    },
    "functionQuery": {
      "functionName": "executeField",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:resolve"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.mjs"
    },
    "functionQuery": {
      "functionName": "executeField",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:resolve"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.js"
    },
    "functionQuery": {
      "functionName": "resolveField",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:resolve"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.mjs"
    },
    "functionQuery": {
      "functionName": "resolveField",
      "kind": "Sync"
    },
    "channelName": "apm:graphql:resolve"
  },
  {
    "module": {
      "name": "@graphql-tools/executor",
      "versionRange": ">=0.0.14",
      "filePath": "cjs/execution/execute.js"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute"
  },
  {
    "module": {
      "name": "@graphql-tools/executor",
      "versionRange": ">=0.0.14",
      "filePath": "esm/execution/execute.js"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "language/printer.js"
    },
    "functionQuery": {
      "functionName": "__module_export__",
      "kind": "Sync"
    },
    "channelName": "dd:graphql:printer:load"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "language/printer.mjs"
    },
    "functionQuery": {
      "functionName": "__module_export__",
      "kind": "Sync"
    },
    "channelName": "dd:graphql:printer:load"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "language/visitor.js"
    },
    "functionQuery": {
      "functionName": "__module_export__",
      "kind": "Sync"
    },
    "channelName": "dd:graphql:visitor:load"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "language/visitor.mjs"
    },
    "functionQuery": {
      "functionName": "__module_export__",
      "kind": "Sync"
    },
    "channelName": "dd:graphql:visitor:load"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "utilities/index.js"
    },
    "functionQuery": {
      "functionName": "__module_export__",
      "kind": "Sync"
    },
    "channelName": "dd:graphql:utilities:load"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "utilities/index.mjs"
    },
    "functionQuery": {
      "functionName": "__module_export__",
      "kind": "Sync"
    },
    "channelName": "dd:graphql:utilities:load"
  }
]
