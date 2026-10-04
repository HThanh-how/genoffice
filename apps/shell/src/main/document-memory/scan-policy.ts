import { SYSTEM_DIRECTORY_NAMES } from '../folder-tree'

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'node_modules',
  'build',
  'coverage',
  'dist',
  'venv',
])
export const SUPPORTED_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ppt',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
])

export function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    name.startsWith('.') ||
    name.startsWith('$') ||
    IGNORED_DIRECTORIES.has(lower) ||
    SYSTEM_DIRECTORY_NAMES.has(lower)
  )
}
