import { it, expect } from 'vitest'
import { NativeHost } from '../src/host/runtime'
import { DEFAULT_LOCAL_OPTIONS, type HostEvent } from '../src/protocol'

it.skipIf(!process.env.GENOFFICE_LFM_MODEL)(
  'loads and chats with the real pinned GGUF',
  async () => {
    const events: HostEvent[] = []
    const host = new NativeHost(
      (event) => events.push(event),
      () => {},
    )
    await host.receive({
      id: 'load',
      type: 'load',
      modelPath: process.env.GENOFFICE_LFM_MODEL!,
      options: { ...DEFAULT_LOCAL_OPTIONS, contextSize: 4096 },
    })
    expect(events.some((e) => e.type === 'error')).toBe(false)
    await host.receive({
      id: 'chat',
      type: 'chat',
      request: {
        system: 'Trả lời bằng tiếng Việt.',
        messages: [{ role: 'user', text: 'Xin chào!' }],
        tools: [],
        maxTokens: 64,
        thinking: false,
      },
    })
    expect(events.some((e) => e.type === 'text')).toBe(true)
    await host.receive({ id: 'unload', type: 'unload' })
  },
  120_000,
)
