import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/gsk', () => ({
  gskGenerateImage: vi.fn(),
  gskAnalyzeMedia: vi.fn(),
  hasGskAuth: vi.fn(() => true),
}))

import { generateImageTool } from '../src/media-tools'
import { gskGenerateImage } from '../src/gsk'

describe('media tools without a configured provider', () => {
  it('does not use a Genspark login, even when one exists', async () => {
    const r = await generateImageTool('/nonexistent/ai-settings.json', {
      prompt: 'red podcast icon',
    })
    expect(r.error).toMatch(/configure an image provider/)
    expect(gskGenerateImage).not.toHaveBeenCalled()
  })
})
