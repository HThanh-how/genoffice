/**
 * Native in-process / utilityProcess inference bridge for Local VLM (LFM3-VL-2B).
 *
 * Implements the architecture recommended in code review:
 * - Direct binary Buffer/Uint8Array transfer via MessagePort (zero-copy, no Base64 conversion).
 * - No HTTP localhost socket overhead, no JSON serialization of multi-megabyte image payloads.
 * - Isolated worker lifecycle via Electron utilityProcess / Worker threads.
 */

export interface LocalVlmBinaryInferResult {
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export type LocalVlmBinaryInferFn = (
  prompt: string,
  images: Uint8Array[],
  signal?: AbortSignal,
) => Promise<LocalVlmBinaryInferResult>

export interface LocalVlmNativeHostBridge {
  /** True when the native worker is initialized and ready to accept inference requests. */
  isAvailable(): boolean
  /** Perform binary inference with direct Uint8Array image buffers. */
  infer(
    prompt: string,
    images: Uint8Array[],
    signal?: AbortSignal,
  ): Promise<LocalVlmBinaryInferResult>
  /** Shut down the worker process cleanly. */
  dispose(): Promise<void>
}

let activeNativeHost: LocalVlmNativeHostBridge | null = null

export function registerLocalVlmNativeHost(host: LocalVlmNativeHostBridge | null): void {
  activeNativeHost = host
}

export function getLocalVlmNativeHost(): LocalVlmNativeHostBridge | null {
  return activeNativeHost
}
