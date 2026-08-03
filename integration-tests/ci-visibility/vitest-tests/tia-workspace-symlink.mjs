import { describe, expect, test } from 'vitest'

import { workspaceValue } from 'tia-workspace-package/source'

describe('TIA workspace symlink suite', () => {
  test('reports a workspace source imported through node_modules', () => {
    expect(workspaceValue).toBe('workspace')
  })
})
