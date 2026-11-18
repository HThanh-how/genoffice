import type { AiProviderId, AiProviderMeta } from '../types'

/**
 * Browser-safe description of the managed local llama.cpp provider. It lives apart from the
 * runtime (llama-server-runtime.ts imports node:child_process), so renderer bundles that need the
 * provider list (providers.ts, registry.ts) never pull Node modules in.
 *
 * Milestone 1: text generation only, one model, no vision, no mmproj, no download.
 */

export const LOCAL_PROVIDER_ID = 'local' satisfies AiProviderId

/** The display / wire id of the single supported model (llama-server serves one model and ignores it). */
export const LOCAL_MODEL_ID = 'lfm3-vl-2b-q4_k_m'

/** The only GGUF file the runtime accepts (compared case-insensitively against the configured path). */
export const LOCAL_MODEL_FILE = 'LFM3-VL-2B-Q4_K_M.gguf'

/**
 * Context window passed to llama-server as `-c` unless GENOFFICE_LOCAL_CTX overrides it.
 *
 * TEMPORARY (evaluation): 65536. The Docs agent's fixed overhead alone (system prompt + 51 tool
 * schemas) measures ≈17.7k LFM3 tokens, so a first Docs turn (~20k) overflowed the earlier 16384.
 * This default only raises the ceiling; prompts, tools and context assembly are unchanged.
 *
 * What it costs (not yet measured on target machines; check llama-server's start-up log, which
 * prints the KV cache size):
 * - RAM: llama-server allocates the KV cache for the whole window at start, whether it is used or
 *   not. LFM3-VL-2B keeps KV only in its attention layers (6 global + 5 sliding-window of 24; the
 *   13 convolution layers have none), so it grows far slower than a plain 2B transformer, but a
 *   64K window still costs several hundred MB on top of the ~1.1 GB model.
 * - Latency: prefill time follows the prompt actually sent, not the window size; a ~20k-token
 *   Docs turn takes minutes to prefill on CPU. llama-server reuses an unchanged prompt prefix, so
 *   later turns of a run are much cheaper than the first.
 * - Low-RAM machines: set GENOFFICE_LOCAL_CTX=16384 (or 32768) to go back to a smaller window.
 */
export const LOCAL_DEFAULT_CTX = 65536

/** Per-turn output cap for this provider; keeps the request inside the context window. */
export const LOCAL_MAX_OUTPUT_TOKENS = 4096

export const LOCAL_PROVIDER_META: AiProviderMeta = {
  id: LOCAL_PROVIDER_ID,
  label: 'Local (llama.cpp)',
  models: [LOCAL_MODEL_ID],
  defaultModel: LOCAL_MODEL_ID,
  keyPlaceholder: '',
  // the llama-server executable path; GENOFFICE_LLAMA_SERVER_PATH is the fallback
  needsCliPath: true,
}

/** Capability flags of this provider: keyless, text-only (consumed by registry.ts). */
export const LOCAL_CAPABILITIES = { auth: 'local-runtime', vision: false } as const
