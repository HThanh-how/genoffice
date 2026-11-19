import { describe, expect, it, vi } from 'vitest'
import {
  LocalVlmNativeHost,
  type MessagePortLike,
} from '../src/main/fork/local-vlm-native-host'
import { recognizeWithLocalVlm } from '../src/main/fork/local-vlm-ocr'

describe('LocalVlmNativeHost (MessagePort zero-copy binary host)', () => {
  it('transfers Uint8Array image buffers directly across MessagePort without Base64 or HTTP', async () => {
    let receivedPrompt = ''
    let receivedImagesCount = 0
    let receivedByteLength = 0

    const host = new LocalVlmNativeHost({
      workerExecutor: async (prompt, images) => {
        receivedPrompt = prompt
        receivedImagesCount = images.length
        receivedByteLength = images.reduce((acc, img) => acc + img.byteLength, 0)
        return {
          text: '=== PAGE 1 ===\n001| Dong van ban nhan dang tu binary host',
          usage: { inputTokens: 42, outputTokens: 18 },
        }
      },
    })

    expect(host.isAvailable()).toBe(true)

    // Raw binary images (3 JPEG bytes in Uint8Array)
    const rawImage1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const rawImage2 = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])

    const result = await host.infer('Doc van ban', [rawImage1, rawImage2])

    expect(receivedPrompt).toBe('Doc van ban')
    expect(receivedImagesCount).toBe(2)
    expect(receivedByteLength).toBe(9)
    expect(result.text).toContain('=== PAGE 1 ===')
    expect(result.text).toContain('001| Dong van ban nhan dang tu binary host')
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 18 })

    await host.dispose()
    expect(host.isAvailable()).toBe(false)
  })

  it('rejects immediately when AbortSignal is already aborted', async () => {
    const host = new LocalVlmNativeHost()
    const abortCtrl = new AbortController()
    abortCtrl.abort()

    await expect(host.infer('test', [], abortCtrl.signal)).rejects.toThrow(
      'Inference aborted',
    )
    await host.dispose()
  })

  it('recognizeWithLocalVlm seamlessly routes to nativeInfer when provided, with zero HTTP or Base64', async () => {
    const fetchFn = vi.fn()
    const nativeCalls: Array<{ prompt: string; images: Uint8Array[] }> = []

    const nativeInfer = async (prompt: string, images: Uint8Array[]) => {
      nativeCalls.push({ prompt, images })
      return {
        text: '=== PAGE 1 ===\n001| Trang mot bang native host\n=== PAGE 2 ===\n001| Trang hai',
        usage: { inputTokens: 80, outputTokens: 24 },
      }
    }

    const ocrResult = await recognizeWithLocalVlm(
      {
        model: 'LFM3-VL-2B',
        pages: [1, 2],
        images: [new Uint8Array([10, 20]), new Uint8Array([30, 40])],
        signal: new AbortController().signal,
      },
      {
        nativeInfer,
        fetchFn: fetchFn as typeof fetch,
      },
    )

    // fetchFn must NOT be called at all: zero HTTP requests!
    expect(fetchFn).not.toHaveBeenCalled()
    // nativeInfer receives the raw Uint8Array images directly (no Base64 strings!)
    expect(nativeCalls.length).toBe(1)
    expect(nativeCalls[0]?.images.length).toBe(2)
    expect(ocrResult.text).toContain('=== PAGE 1 ===')
    expect(ocrResult.text).toContain('001| Trang mot bang native host')
    expect(ocrResult.usage).toEqual({ inputTokens: 80, outputTokens: 24 })
  })
})
