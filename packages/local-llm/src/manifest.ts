export const LFM_MANIFEST = {
  id: 'lfm3-vl-2b',
  repo: 'LiquidAI/LFM3-VL-2B-GGUF',
  revision: '1add221a5ea6c047fcf1eaaf2d247939d7cf8849',
  mirrorable: false,
  license: {
    id: 'lfm1.0',
    name: 'LFM Open License v1.0',
    url: 'https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF/blob/1add221a5ea6c047fcf1eaaf2d247939d7cf8849/LICENSE',
    notice:
      'Entities with annual revenue above USD 10 million require a separate agreement with Liquid AI.',
  },
  files: [
    {
      path: 'LFM3-VL-2B-Q4_K_M.gguf',
      bytes: 1099627808,
      sha256: '56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb',
      optional: false,
      purpose: 'chat',
    },
    {
      path: 'mmproj-LFM3-VL-2B-Q8_0.gguf',
      bytes: 203031872,
      sha256: 'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab',
      optional: true,
      purpose: 'vision',
    },
  ],
} as const

export const LFM_SAMPLING = {
  temperature: 0.1,
  topK: 50,
  topP: 1,
  minP: 0,
  repeatPenalty: 1.1,
} as const

export function modelUrl(file = LFM_MANIFEST.files[0].path): string {
  return `https://huggingface.co/${LFM_MANIFEST.repo}/resolve/${LFM_MANIFEST.revision}/${file}`
}
