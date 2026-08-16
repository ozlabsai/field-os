import { describe, expect, it } from 'vitest'

import { looksLikeCredential } from './AddModelModal'

// Guards the Display Name field, which is rendered verbatim in the providers list, the composer's
// model selector and its dropdown. It must reject pasted credentials without rejecting the model
// names people actually type — a false positive here blocks a legitimate save, so the negative
// cases matter as much as the positive ones.
describe('looksLikeCredential', () => {
  it('rejects keys with a known provider prefix', () => {
    expect(looksLikeCredential('sk-or-v1-6a9a883d12a3544380295bdcdc12f822bab9ab5761101e')).toBe(true)
    expect(looksLikeCredential('sk-ant-api03-abc123')).toBe(true)
    expect(looksLikeCredential('ghp_16CharsOfTokenHere')).toBe(true)
    expect(looksLikeCredential('AIzaSyC-abc123def456')).toBe(true)
    // Prefix wins even when the value is short enough to pass the length heuristic.
    expect(looksLikeCredential('sk-short')).toBe(true)
  })

  it('rejects long opaque tokens with no recognizable prefix', () => {
    expect(looksLikeCredential('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(true)
  })

  it('accepts the model names people actually type', () => {
    expect(looksLikeCredential('Sonnet 4.5 (OpenRouter)')).toBe(false)
    expect(looksLikeCredential('Gemma 4 31B')).toBe(false)
    expect(looksLikeCredential('gemma4:31b')).toBe(false)
    expect(looksLikeCredential('anthropic/claude-sonnet-4.5')).toBe(false)
    expect(looksLikeCredential('Llama 3.3 70B Instruct')).toBe(false)
    expect(looksLikeCredential('my local vLLM')).toBe(false)
  })

  it('does not reject a long name that reads as a name', () => {
    // Long, but has whitespace -- a person wrote it.
    expect(looksLikeCredential('Claude Sonnet 4.5 running on the internal cluster')).toBe(false)
    // Long and unbroken, but letters only: a slug, not a token.
    expect(looksLikeCredential('averyveryverylongmodelnamewithoutanydigitsatall')).toBe(false)
  })

  it('ignores surrounding whitespace', () => {
    expect(looksLikeCredential('  sk-or-v1-abc123  ')).toBe(true)
    expect(looksLikeCredential('  Gemma 4 31B  ')).toBe(false)
  })
})
