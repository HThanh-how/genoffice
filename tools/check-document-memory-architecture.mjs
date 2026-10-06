import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Enterprise Architecture Boundary & LOC Checker for Document Search V3
 *
 * Required checks:
 * 1. Manager: NO DatabaseSync, NO .prepare(, NO SELECT, NO INSERT, NO UPDATE, NO DELETE, NO PRAGMA.
 * 2. Snapshot: NO getDocumentIndexDiagnostics(, NO getStorageDiagnostics(.
 * 3. Renderer: NO storage/repository imports.
 * 4. IPC: NO DatabaseSync.
 * 5. Schema: chunks.vector => FAIL, chunks.vector_dim => FAIL, chunks.normalized => FAIL.
 *    (Any vector column in chunks table => FAIL).
 * 6. Giới hạn LOC:
 *    manager.ts <= 500
 *    store.ts <= 400
 *    storage-migration.ts <= 200
 *    document-index-ipc.ts <= 250
 *    IndexDashboard.tsx <= 250
 */

const rootDir = process.cwd()
let hasErrors = false

console.log('=== Checking Document Search V3 Architecture Boundaries ===\n')

// 1. Manager Boundary Check
// Manager: NO DatabaseSync, NO .prepare(, NO SELECT, NO INSERT, NO UPDATE, NO DELETE, NO PRAGMA.
const managerRelPath = 'apps/shell/src/main/document-memory/manager.ts'
const managerPath = resolve(rootDir, managerRelPath)
try {
  const managerContent = readFileSync(managerPath, 'utf8')
  const managerViolations = []
  if (managerContent.includes('DatabaseSync')) managerViolations.push('DatabaseSync')
  if (managerContent.includes('.prepare(')) managerViolations.push('.prepare(')
  if (/\bSELECT\b/.test(managerContent)) managerViolations.push('SELECT')
  if (/\bINSERT\b/.test(managerContent)) managerViolations.push('INSERT')
  if (/\bUPDATE\b/.test(managerContent)) managerViolations.push('UPDATE')
  if (/\bDELETE\b/.test(managerContent)) managerViolations.push('DELETE')
  if (/\bPRAGMA\b/i.test(managerContent)) managerViolations.push('PRAGMA')

  if (managerViolations.length > 0) {
    console.error(`[FAIL] Manager boundary violated (${managerRelPath}): forbidden pattern(s) found: ${managerViolations.join(', ')}`)
    hasErrors = true
  } else {
    console.log('[PASS] Manager: NO DatabaseSync, NO .prepare(, NO SELECT, NO INSERT, NO UPDATE, NO DELETE, NO PRAGMA')
  }
} catch (err) {
  console.error(`[FAIL] Unable to read Manager (${managerRelPath}): ${err.message}`)
  hasErrors = true
}

// 2. Snapshot Boundary Check
// Snapshot: NO getDocumentIndexDiagnostics(, NO getStorageDiagnostics(.
const snapshotFiles = [
  'apps/shell/src/renderer/src/fork/useIndexSnapshot.ts',
  'apps/shell/src/renderer/src/fork/IndexDashboard.tsx',
]
let snapshotPassed = true
for (const relPath of snapshotFiles) {
  const fullPath = resolve(rootDir, relPath)
  try {
    const content = readFileSync(fullPath, 'utf8')
    const violations = []
    if (content.includes('getDocumentIndexDiagnostics(')) violations.push('getDocumentIndexDiagnostics(')
    if (content.includes('getStorageDiagnostics(')) violations.push('getStorageDiagnostics(')

    if (violations.length > 0) {
      console.error(`[FAIL] Snapshot boundary violated (${relPath}): forbidden call(s) found: ${violations.join(', ')}`)
      hasErrors = true
      snapshotPassed = false
    }
  } catch (err) {
    console.error(`[FAIL] Unable to read Snapshot file (${relPath}): ${err.message}`)
    hasErrors = true
    snapshotPassed = false
  }
}
if (snapshotPassed) {
  console.log('[PASS] Snapshot: NO getDocumentIndexDiagnostics(, NO getStorageDiagnostics(')
}

// 3. Renderer Boundary Check
// Renderer: NO storage/repository imports.
const rendererDir = resolve(rootDir, 'apps/shell/src/renderer')
function getRendererFiles(dir) {
  let results = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      results = results.concat(getRendererFiles(full))
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      results.push(full)
    }
  }
  return results
}

try {
  const rendererFiles = getRendererFiles(rendererDir)
  const importRegex = /(?:import\s+(?:[\s\S]*?from\s+)?|export\s+[\s\S]*?from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g
  let rendererViolations = 0
  for (const filePath of rendererFiles) {
    const content = readFileSync(filePath, 'utf8')
    let match
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1]
      if (/(?:^|\/)(?:storage|repository|repositories)(?:\/|$)/i.test(specifier)) {
        const relPath = filePath.replace(rootDir + '\\', '').replace(rootDir + '/', '')
        console.error(`[FAIL] Renderer boundary violated in ${relPath}: forbidden storage/repository import "${specifier}"`)
        hasErrors = true
        rendererViolations++
      }
    }
  }
  if (rendererViolations === 0) {
    console.log(`[PASS] Renderer: NO storage/repository imports (${rendererFiles.length} files scanned)`)
  }
} catch (err) {
  console.error(`[FAIL] Unable to scan Renderer files: ${err.message}`)
  hasErrors = true
}

// 4. IPC Boundary Check
// IPC: NO DatabaseSync.
const ipcFiles = [
  'apps/shell/src/main/fork/document-index-ipc.ts',
  'apps/shell/src/main/fork/document-index-folder-handlers.ts',
]
let ipcPassed = true
for (const relPath of ipcFiles) {
  const fullPath = resolve(rootDir, relPath)
  try {
    const content = readFileSync(fullPath, 'utf8')
    if (content.includes('DatabaseSync')) {
      console.error(`[FAIL] IPC boundary violated (${relPath}): DatabaseSync is forbidden!`)
      hasErrors = true
      ipcPassed = false
    }
  } catch (err) {
    console.error(`[FAIL] Unable to read IPC file (${relPath}): ${err.message}`)
    hasErrors = true
    ipcPassed = false
  }
}
if (ipcPassed) {
  console.log('[PASS] IPC: NO DatabaseSync')
}

// 5. Schema Canonical Invariants
// chunks.vector => FAIL, chunks.vector_dim => FAIL, chunks.normalized => FAIL.
// (Any vector column existing in chunks table => FAIL).
const schemaRelPath = 'apps/shell/src/main/document-memory/storage/schema-v3.ts'
const schemaPath = resolve(rootDir, schemaRelPath)
try {
  const schemaContent = readFileSync(schemaPath, 'utf8')
  const chunksMatch = schemaContent.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?chunks\s*\(([\s\S]*?)\);/i)
  if (!chunksMatch) {
    console.error(`[FAIL] Schema check failed: could not locate "chunks" table in ${schemaRelPath}!`)
    hasErrors = true
  } else {
    const chunkColumns = chunksMatch[1]
    let schemaViolations = 0

    if (/\bvector\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains "vector" column!')
      hasErrors = true
      schemaViolations++
    }
    if (/\bvector_dim\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains "vector_dim" column!')
      hasErrors = true
      schemaViolations++
    }
    if (/\bnormalized\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains "normalized" column!')
      hasErrors = true
      schemaViolations++
    }
    if (/\b(embedding|dim|dims)\b/i.test(chunkColumns)) {
      console.error('[FAIL] Invariant INV-03 violated: chunks table contains vector column!')
      hasErrors = true
      schemaViolations++
    }

    if (schemaViolations === 0) {
      console.log('[PASS] Schema: chunks table contains NO vector, vector_dim, normalized, or obsolete vector columns')
    }
  }
} catch (err) {
  console.error(`[FAIL] Unable to read ${schemaRelPath}: ${err.message}`)
  hasErrors = true
}

// 6. LOC Limits
const LOC_LIMITS = {
  'apps/shell/src/main/document-memory/manager.ts': 500,
  'apps/shell/src/main/document-memory/store.ts': 400,
  'apps/shell/src/main/document-memory/storage-migration.ts': 200,
  'apps/shell/src/main/fork/document-index-ipc.ts': 250,
  'apps/shell/src/renderer/src/fork/IndexDashboard.tsx': 250,
}

for (const [relPath, maxLoc] of Object.entries(LOC_LIMITS)) {
  const fullPath = resolve(rootDir, relPath)
  try {
    const content = readFileSync(fullPath, 'utf8')
    const lines = content.split('\n').length
    if (lines > maxLoc) {
      console.error(`[FAIL] ${relPath}: ${lines} LOC exceeds limit of ${maxLoc} LOC!`)
      hasErrors = true
    } else {
      console.log(`[PASS] ${relPath}: ${lines} LOC (Limit: <= ${maxLoc})`)
    }
  } catch (err) {
    console.error(`[FAIL] Unable to read ${relPath}: ${err.message}`)
    hasErrors = true
  }
}

if (hasErrors) {
  console.error('\nArchitecture check FAILED.')
  process.exit(1)
} else {
  console.log('\nAll architecture boundaries PASSED.')
  process.exit(0)
}
