import { copy as zh } from './zh'
export const copy = {
  title: 'Local chat model',
  missing: 'Not downloaded',
  checking: 'Verifying SHA-256…',
  downloading: 'Downloading {n}%',
  paused: 'Paused {n}%',
  ready: 'Ready',
  error: 'Error',
  download: 'Download',
  cancel: 'Cancel',
  resume: 'Resume',
  remove: 'Delete model',
  keepHot: 'Keep warm (minutes)',
  thinking: 'Reasoning (slower)',
  autoDownload: 'Download model when needed',
  advanced: 'Advanced',
  threads: 'CPU threads',
  gpu: 'Backend',
  context: 'Context tokens',
  limits:
    'Text only. Images are not supported yet. Not recommended for coding, long conversations or complex reasoning.',
  license:
    'LFM Open License v1.0: annual revenue above USD 10 million requires a separate agreement with Liquid AI.',
  gpuWarning:
    'CPU is the default. Vulkan crashed on Radeon 780M in testing; advanced GPU backends require a separately installed compatible runtime.',
  offline: 'Offline. Connect to download the local model.',
  metered: 'Metered network: automatic model download is paused. Download manually to continue.',
} satisfies Record<keyof typeof zh, string>
