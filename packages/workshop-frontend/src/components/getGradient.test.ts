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

  it('borrows no vendor brand colour and no inherited orange', () => {
    // The old palette was literally Slack / Jira / Discord / Google / GitHub hexes -- the same
    // values ConnectionLogos.tsx uses to identify those services -- plus an orange-to-red pair.
    // Decoration must not look like a service badge, and orange is what this fork is migrating off.
    const VENDOR = ['4a154b', '0052cc', '5865f2', '34a853', '4285f4', '24292e', 'e01e5a', 'ecb22e']
    const ids = Array.from({ length: 40 }, (_, i) => `blueprint.sample-${i}`)
    for (const g of new Set(ids.map(getGradient))) {
      const lower = g.toLowerCase()
      for (const v of VENDOR) expect(lower).not.toContain(v)
      expect(lower).not.toContain('orange')
      expect(lower).not.toContain('red-')
    }
  })
})
