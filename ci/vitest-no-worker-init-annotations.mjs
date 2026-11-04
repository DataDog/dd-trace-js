import * as declarations from '../packages/dd-trace/src/ci-visibility/test-declaration-annotations.js'

export const { captureDeclarations } = declarations.default ||
  globalThis[Symbol.for('dd-trace.vitest.declaration-annotations')]
