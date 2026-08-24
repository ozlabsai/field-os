import { describe, expect, it } from 'vitest'
import { getGradient } from './BlueprintCard'

describe('getGradient', () => {
  // The gradient is the only per-blueprint mark on a preview placeholder, and placeholders are
  // permanent on this fork (screenshots need the BROWSER binding, which standalone workerd lacks).
  // Hashing only the first character made every namespaced id collide.
  it('separates the format blueprints this deployment ships', () => {
    const ids = ['format.document', 'format.slides', 'format.spreadsheet']
    expect(new Set(ids.map(getGradient)).size).toBe(ids.length)
  })

  it('does not key on the first character alone', () => {
    // Same leading char, different ids: these must not all land on one gradient.
    const ids = ['aaa', 'abb', 'acc', 'add']
    expect(new Set(ids.map(getGradient)).size).toBeGreaterThan(1)
  })

  it('is stable for a given id', () => {
    expect(getGradient('format.slides')).toBe(getGradient('format.slides'))
  })
})
