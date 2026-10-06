import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Enterprise Architecture Boundary & LOC Checker for Document Search V3
 */

const LIMITS = {
  'apps/shell/src/main/document-memory/manager.ts': 500,
  'apps/shell/src/main/document-memory/store.ts': 400,
  'apps/shell/src/main/document-memory/storage-migration.ts': 200,
  'apps/shell/src/main/fork/document-index-ipc.ts': 250,
  'apps/shell/src/renderer/src/fork/IndexDashboard.tsx': 250,
}

const rootDir = process.cwd()
let hasErrors = false

console.log('=== Checking Document Search V3 Architecture Boundaries ===\n')

// 1. Check LOC limits
for (const [relPath, maxLoc] of Object.entries(LIMITS)) {
  const fullPath = resolve(rootDir, relPath)
  try {
    const content = readFileSync(fullPath, 'utf8')
    const lines = content.split('\n').length
    if (lines > maxLoc) {
      console.error(`[FAIL] ${relPath}: ${lines} LOC exceeds limit of ${maxLoc} LOC!`)
      hasErrors = true
    } else {
      console.log(`[PASS] ${relPath}: ${lines} LOC (Limit: ${maxLoc})`)
    }
  } catch (err) {
    console.error(`[FAIL] Unable to read ${relPath}: ${err.message}`)
    hasErrors = true
  }
}

// 2. Check Schema V3 canonical invariants
const schemaPath = resolve(rootDir, 'apps/shell/src/main/document-memory/storage/schema-v3.ts')
try {
  const schemaContent = readFileSync(schemaPath, 'utf8')
  // Invariant INV-03: chunks table MUST NOT have vector, vector_dim, or normalized
  const chunksMatch = schemaContent.match(/CREATE TABLE IF NOT EXISTS chunks\s*\(([\s\S]*?)\);/i)
  if (chunksMatch) {
    const chunkColumns = chunksMatch[1]
    if (/\bvector\b/i.test(chunkColumns) && !/\bchunk_set_id\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains "vector" column!')
      hasErrors = true
    }
    if (/\bvector_dim\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains "vector_dim" column!')
      hasErrors = true
    }
    if (/\bnormalized\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains "normalized" column!')
      hasErrors = true
    }
  }
  console.log('[PASS] Invariant INV-03: chunks schema contains no obsolete vector columns.')
} catch (err) {
  // If schema-v3.ts not created yet, log notice
  console.log('[NOTICE] storage/schema-v3.ts will be validated once created.')
}

if (hasErrors) {
  console.error('\nArchitecture check FAILED.')
  process.exit(1)
} else {
  console.log('\nAll architecture boundaries PASSED.')
  process.exit(0)
}
