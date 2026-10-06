import type { WorkbookExportPdfResult } from '../shared/desktop-api'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePdfExportResult(value: unknown): WorkbookExportPdfResult {
  if (!isRecord(value) || typeof value.canceled !== 'boolean') {
    throw new Error('Invalid PDF export response.')
  }

  if (value.canceled === true) {
    if (value.path !== undefined || value.error !== undefined) {
      throw new Error('Invalid PDF export response.')
    }
    return { canceled: true }
  }

  if (typeof value.path === 'string' && value.path.length > 0 && value.error === undefined) {
    return { canceled: false, path: value.path }
  }

  if (value.path === undefined && value.error === 'destination-busy') {
    return { canceled: false, error: 'destination-busy' }
  }

  throw new Error('Invalid PDF export response.')
}
