import { describe, expect, test } from 'vitest'

describe('vitest browser reporting', () => {
  test('runs the test body in the browser', () => {
    document.body.innerHTML = '<button>Save</button>'

    expect(document.querySelector('button')?.textContent).toBe('Save')
    expect(window.location.protocol).toMatch(/^https?:$/)
  })

  test.skip('reports skipped browser tests', () => {})
})
