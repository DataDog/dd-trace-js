module.exports = [
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.js"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute:start"
  },
  {
    "module": {
      "name": "graphql",
      "versionRange": ">=0.10",
      "filePath": "execution/execute.mjs"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute:start"
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
    "channelName": "apm:graphql:parser:start"
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
    "channelName": "apm:graphql:parser:start"
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
    "channelName": "apm:graphql:validate:start"
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
    "channelName": "apm:graphql:validate:start"
  },
  {
    "module": {
      "name": "@graphql-tools/executor",
      "versionRange": ">=0.0.14",
      "filePath": "cjs/index.js"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute:start"
  },
  {
    "module": {
      "name": "@graphql-tools/executor",
      "versionRange": ">=0.0.14",
      "filePath": "esm/index.js"
    },
    "functionQuery": {
      "functionName": "execute",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute:start"
  },
  {
    "module": {
      "name": "@graphql-tools/executor",
      "versionRange": ">=0.0.14",
      "filePath": "cjs/index.js"
    },
    "functionQuery": {
      "functionName": "normalizedExecutor",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute:start"
  },
  {
    "module": {
      "name": "@graphql-tools/executor",
      "versionRange": ">=0.0.14",
      "filePath": "esm/index.js"
    },
    "functionQuery": {
      "functionName": "normalizedExecutor",
      "kind": "Async"
    },
    "channelName": "apm:graphql:execute:start"
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
    "channelName": "apm:graphql:execute:start"
  }
]
