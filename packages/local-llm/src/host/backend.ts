import type { Llama, LlamaOptions } from 'node-llama-cpp'

type GetLlama = (options: LlamaOptions) => Promise<Llama>
type Gpu = LlamaOptions['gpu']

/** node-llama-cpp's NoBinaryFoundError, matched by name so the check also works across a bundle boundary. */
export function isNoBinaryFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'NoBinaryFoundError' || error.constructor?.name === 'NoBinaryFoundError')
  )
}

/**
 * Open the native backend the person asked for. "CPU only" (`gpu: false`) needs a CPU build of
 * llama.cpp, and the prebuilt package shipped for Apple Silicon is Metal-only: with building
 * disabled that request fails with NoBinaryFoundError on every M-series Mac, so the default
 * setting would leave the local model unusable there. When no CPU build exists the available
 * backend is opened instead; the caller keeps every layer on the CPU (gpuLayers 0), so the
 * choice of "CPU" still holds for where the model runs.
 */
export async function openLlama(
  getLlama: GetLlama,
  gpu: Gpu,
  base: Omit<LlamaOptions, 'gpu'>,
): Promise<{ llama: Llama; backendFallback: boolean }> {
  try {
    return { llama: await getLlama({ ...base, gpu }), backendFallback: false }
  } catch (error) {
    if (gpu !== false || !isNoBinaryFound(error)) throw error
    return { llama: await getLlama({ ...base, gpu: 'auto' }), backendFallback: true }
  }
}
