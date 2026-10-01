import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWorkflowPlist,
  installMacFolderScanService,
  type MacServiceCommandRunner,
} from '../src/main/mac-folder-scan-service'

const tempDirectories: string[] = []
afterEach(() => {
  for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempHome() {
  const path = mkdtempSync(join(tmpdir(), 'genoffice-mac-service-'))
  tempDirectories.push(path)
  return path
}

function fakeSystemServices(initialStatus = '') {
  const calls: Array<{ command: string; args: string[] }> = []
  let status = initialStatus
  const run: MacServiceCommandRunner = (command, args) => {
    calls.push({ command, args })
    if (command.endsWith('/defaults') && args[0] === 'read') {
      if (!status) throw new Error('No services preference')
      return status
    }
    if (command.endsWith('/defaults') && args[0] === 'write') {
      status +=
        ' "com.genoffice.app.folder-scan-service - Scan with GenOffice AI - runWorkflowAsService"'
    }
    return ''
  }
  return { run, calls }
}

describe('macOS Finder folder scan service', () => {
  it('creates a folder-only Finder Quick Action and passes one quoted folder argument', () => {
    const plist = buildWorkflowPlist()
    expect(plist).toContain('com.apple.Automator.fileSystemObject.folder')
    expect(plist).toContain(
      '<key>serviceApplicationBundleID</key><string>com.apple.finder</string>',
    )
    expect(plist).toContain(
      '/usr/bin/open -n -b com.genoffice.app --args --genoffice-scan-folder &quot;$1&quot;',
    )
    expect(plist).toContain('[ &quot;$#&quot; -ne 1 ]')
  })

  it.skipIf(process.platform !== 'darwin')(
    'writes valid Finder folder service registration and Automator workflow plists',
    () => {
      const home = tempHome()
      const system = fakeSystemServices()
      installMacFolderScanService(home, system.run)
      const workflow = join(home, 'Library', 'Services', 'GenOffice Scan Folder.workflow')
      const contents = join(workflow, 'Contents')
      expect(existsSync(join(contents, 'document.wflow'))).toBe(true)
      expect(existsSync(join(contents, 'Info.plist'))).toBe(true)
      expect(existsSync(join(contents, 'GenOfficeManagedWorkflow.json'))).toBe(true)
      execFileSync('/usr/bin/plutil', ['-lint', join(contents, 'document.wflow')])
      execFileSync('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')])
      const info = JSON.parse(
        execFileSync(
          '/usr/bin/plutil',
          ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')],
          { encoding: 'utf8' },
        ),
      ) as {
        NSServices: Array<{
          NSRequiredContext: { NSApplicationIdentifier: string }
          NSSendFileTypes: string[]
          NSSendTypes: string[]
        }>
      }
      expect(info.NSServices[0]).toMatchObject({
        NSRequiredContext: { NSApplicationIdentifier: 'com.apple.finder' },
        NSSendFileTypes: ['public.folder'],
        NSSendTypes: ['NSFilenamesPboardType'],
      })
      const write = system.calls.find(
        (call) => call.command.endsWith('/defaults') && call.args[0] === 'write',
      )
      expect(write?.args).toContain('NSServicesStatus')
      expect(write?.args.at(-1)).toContain('ContextMenu = 1')
      expect(system.calls.some((call) => call.command.endsWith('/pbs'))).toBe(true)
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'leaves a user workflow at the install path untouched',
    () => {
      const home = tempHome()
      const workflow = join(home, 'Library', 'Services', 'GenOffice Scan Folder.workflow')
      const userFile = join(workflow, 'Contents', 'document.wflow')
      const original = 'user-owned workflow'
      mkdirSync(join(workflow, 'Contents'), { recursive: true })
      writeFileSync(userFile, original)

      installMacFolderScanService(home, fakeSystemServices().run)

      expect(readFileSync(userFile, 'utf8')).toBe(original)
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'reinstalls owned workflows idempotently without rewriting them',
    () => {
      const home = tempHome()
      const system = fakeSystemServices()
      installMacFolderScanService(home, system.run)
      const workflow = join(home, 'Library', 'Services', 'GenOffice Scan Folder.workflow')
      const documentPath = join(workflow, 'Contents', 'document.wflow')
      const before = readFileSync(documentPath)
      const modifiedBefore = statMtime(documentPath)

      installMacFolderScanService(home, system.run)

      expect(readFileSync(documentPath)).toEqual(before)
      expect(statMtime(documentPath)).toBe(modifiedBefore)
      expect(
        system.calls.filter(
          (call) => call.command.endsWith('/defaults') && call.args[0] === 'write',
        ),
      ).toHaveLength(1)
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'preserves an existing disabled Quick Action preference',
    () => {
      const home = tempHome()
      const key =
        'com.genoffice.app.folder-scan-service - Scan with GenOffice AI - runWorkflowAsService'
      const system = fakeSystemServices(
        `"${key}" = { presentation_modes = { ContextMenu = 0; }; };`,
      )
      installMacFolderScanService(home, system.run)

      expect(
        system.calls.some((call) => call.command.endsWith('/defaults') && call.args[0] === 'write'),
      ).toBe(false)
      expect(system.calls.some((call) => call.command.endsWith('/pbs'))).toBe(true)
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'refreshes Services when updating an owned workflow while preserving its toggle',
    () => {
      const home = tempHome()
      const key =
        'com.genoffice.app.folder-scan-service - Scan with GenOffice AI - runWorkflowAsService'
      const system = fakeSystemServices(
        `"${key}" = { presentation_modes = { ContextMenu = 0; }; };`,
      )
      installMacFolderScanService(home, system.run)
      const workflow = join(home, 'Library', 'Services', 'GenOffice Scan Folder.workflow')
      const documentPath = join(workflow, 'Contents', 'document.wflow')
      writeFileSync(documentPath, 'outdated workflow')
      system.calls.length = 0

      installMacFolderScanService(home, system.run)

      expect(readFileSync(documentPath, 'utf8')).toContain(
        'com.apple.Automator.fileSystemObject.folder',
      )
      expect(
        system.calls.some((call) => call.command.endsWith('/defaults') && call.args[0] === 'write'),
      ).toBe(false)
      expect(system.calls.filter((call) => call.command.endsWith('/pbs'))).toHaveLength(1)
    },
  )
})

function statMtime(path: string): number {
  return statSync(path).mtimeMs
}
