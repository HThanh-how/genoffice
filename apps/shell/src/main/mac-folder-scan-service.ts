import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVICE_NAME = 'GenOffice Scan Folder'
const WORKFLOW_NAME = `${SERVICE_NAME}.workflow`
const OWNER = 'com.genoffice.app.folder-scan-service'
const VERSION = 1
const APP_BUNDLE_ID = 'com.genoffice.app'
const MAX_SELECTED_FOLDERS = 1
const SERVICE_MENU_TITLE = 'Scan with GenOffice AI'
const SERVICE_STATUS_KEY = `${OWNER} - ${SERVICE_MENU_TITLE} - runWorkflowAsService`

export type MacServiceCommandRunner = (command: string, args: string[]) => string

const runSystemCommand: MacServiceCommandRunner = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const shellScript = `if [ "$#" -ne ${MAX_SELECTED_FOLDERS} ] || [ ! -d "$1" ]; then
  exit 1
fi
/usr/bin/open -n -b ${APP_BUNDLE_ID} --args --genoffice-scan-folder "$1"
`

interface OwnershipMarker {
  owner: string
  version: number
}

/** Install the Finder Quick Action on macOS. Call on packaged app startup. */
export function installMacFolderScanService(
  homeDirectory = homedir(),
  runCommand: MacServiceCommandRunner = runSystemCommand,
): void {
  if (process.platform !== 'darwin') return

  const servicesDirectory = join(homeDirectory, 'Library', 'Services')
  const destination = join(servicesDirectory, WORKFLOW_NAME)
  const markerPath = join(destination, 'Contents', 'GenOfficeManagedWorkflow.json')
  let replaceOwnedWorkflow = false
  const workflowContents = buildWorkflowPlist()
  const infoContents = buildInfoPlist()
  if (existsSync(destination)) {
    let marker: Partial<OwnershipMarker>
    try {
      if (lstatSync(destination).isSymbolicLink()) return
      marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<OwnershipMarker>
    } catch {
      // The target name may belong to a user-created workflow. Leave it intact.
      return
    }
    if (marker.owner !== OWNER) return
    replaceOwnedWorkflow = true
    try {
      if (
        marker.version === VERSION &&
        readFileSync(join(destination, 'Contents', 'document.wflow'), 'utf8') ===
          workflowContents &&
        readFileSync(join(destination, 'Contents', 'Info.plist'), 'utf8') === infoContents
      )
        return ensureQuickActionEnabled(runCommand)
    } catch {
      // An incomplete workflow with our marker can be repaired in place.
    }
  }

  const staging = join(servicesDirectory, `.${SERVICE_NAME}.${randomUUID()}.workflow`)
  const backup = `${destination}.genoffice-backup-${randomUUID()}`
  try {
    mkdirSync(servicesDirectory, { recursive: true })
    mkdirSync(join(staging, 'Contents'), { recursive: true, mode: 0o700 })
    writeFileSync(join(staging, 'Contents', 'document.wflow'), workflowContents, {
      mode: 0o600,
    })
    writeFileSync(join(staging, 'Contents', 'Info.plist'), infoContents, { mode: 0o600 })
    writeFileSync(
      join(staging, 'Contents', 'GenOfficeManagedWorkflow.json'),
      `${JSON.stringify({ owner: OWNER, version: VERSION })}\n`,
      { mode: 0o600 },
    )

    if (replaceOwnedWorkflow) renameSync(destination, backup)
    try {
      renameSync(staging, destination)
    } catch (error) {
      if (replaceOwnedWorkflow && existsSync(backup)) renameSync(backup, destination)
      throw error
    }
    if (replaceOwnedWorkflow) rmSync(backup, { recursive: true, force: true })
    ensureQuickActionEnabled(runCommand, true)
  } catch {
    rmSync(staging, { recursive: true, force: true })
    // Service installation is best-effort and must not prevent app startup.
  }
}

function ensureQuickActionEnabled(
  runCommand: MacServiceCommandRunner,
  refreshChangedWorkflow = false,
): void {
  let registered = false
  try {
    const status = runCommand('/usr/bin/defaults', ['read', 'pbs', 'NSServicesStatus'])
    registered = status.includes(JSON.stringify(SERVICE_STATUS_KEY))
  } catch {
    // No Services status has been recorded for this workflow yet.
  }
  if (registered) {
    if (refreshChangedWorkflow) {
      try {
        runCommand('/System/Library/CoreServices/pbs', ['-update'])
      } catch {
        // The updated workflow remains installed if Services refresh fails.
      }
    }
    return
  }

  try {
    runCommand('/usr/bin/defaults', [
      'write',
      'pbs',
      'NSServicesStatus',
      '-dict-add',
      SERVICE_STATUS_KEY,
      '{ presentation_modes = { ContextMenu = 1; FinderPreview = 1; ServicesMenu = 1; TouchBar = 0; }; }',
    ])
    runCommand('/System/Library/CoreServices/pbs', ['-update'])
  } catch {
    // The Services menu still works if macOS declines the optional Finder toggle.
  }
}

/** Exported for schema and quoting tests without installing anything. */
export function buildWorkflowPlist(): string {
  const script = xmlEscape(shellScript)
  const action = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>actions</key><array><dict>
    <key>action</key><dict>
      <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
      <key>ActionName</key><string>Run Shell Script</string>
      <key>ActionParameters</key><dict>
        <key>CheckedForUserDefaultShell</key><true/>
        <key>COMMAND_STRING</key><string>${script}</string>
        <key>inputMethod</key><integer>1</integer>
        <key>shell</key><string>/bin/zsh</string>
        <key>source</key><string></string>
      </dict>
      <key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
      <key>AMActionVersion</key><string>2.0.3</string>
      <key>AMApplication</key><array><string>Automator</string></array>
      <key>AMParameterProperties</key><dict>
        <key>CheckedForUserDefaultShell</key><dict/><key>COMMAND_STRING</key><dict/>
        <key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/>
      </dict>
      <key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
      <key>arguments</key><dict>
        <key>0</key><dict><key>default value</key><integer>0</integer><key>name</key><string>inputMethod</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>0</string></dict>
        <key>1</key><dict><key>default value</key><false/><key>name</key><string>CheckedForUserDefaultShell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>1</string></dict>
        <key>2</key><dict><key>default value</key><string></string><key>name</key><string>source</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>2</string></dict>
        <key>3</key><dict><key>default value</key><string></string><key>name</key><string>COMMAND_STRING</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>3</string></dict>
        <key>4</key><dict><key>default value</key><string>/bin/sh</string><key>name</key><string>shell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>4</string></dict>
      </dict>
      <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
      <key>CanShowSelectedItemsWhenRun</key><false/><key>CanShowWhenRun</key><true/>
      <key>Category</key><array><string>AMCategoryUtilities</string></array>
      <key>CFBundleVersion</key><string>2.0.3</string>
      <key>Class Name</key><string>RunShellScriptAction</string>
      <key>conversionLabel</key><integer>0</integer>
      <key>Keywords</key><array><string>Folder</string><string>GenOffice</string><string>Scan</string></array>
      <key>InputUUID</key><string>1D5230B1-0468-4350-9F3C-141CB4B7C239</string>
      <key>isViewVisible</key><integer>1</integer>
      <key>location</key><string>309.000000:305.000000</string>
      <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      <key>OutputUUID</key><string>2FBA2BB5-2928-454E-B1AC-10AECCFBA5FE</string>
      <key>UnlocalizedApplications</key><array><string>Automator</string></array>
      <key>UUID</key><string>146E4845-6112-4A9C-8B48-6C778D1AF2B1</string>
    </dict><key>isViewVisible</key><integer>1</integer>
  </dict></array>
  <key>AMApplicationBuild</key><string>534</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key><dict>
    <key>applicationBundleID</key><string>com.apple.finder</string>
    <key>applicationBundleIDsByPath</key><dict><key>/System/Library/CoreServices/Finder.app</key><string>com.apple.finder</string></dict>
    <key>applicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
    <key>applicationPaths</key><array><string>/System/Library/CoreServices/Finder.app</string></array>
    <key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
    <key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>presentationMode</key><integer>15</integer>
    <key>processesInput</key><false/>
    <key>serviceApplicationBundleID</key><string>com.apple.finder</string>
    <key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key><false/>
    <key>systemImageName</key><string>NSActionTemplate</string>
    <key>useAutomaticInputType</key><false/>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict></plist>
`
  return action
}

function buildInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${OWNER}</string>
  <key>CFBundleName</key><string>${SERVICE_NAME}</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>GenOfficeManagedWorkflowVersion</key><integer>${VERSION}</integer>
  <key>NSServices</key><array><dict>
    <key>NSBackgroundColorName</key><string>background</string>
    <key>NSIconName</key><string>NSActionTemplate</string>
    <key>NSMenuItem</key><dict>
      <key>default</key><string>Scan with GenOffice AI</string>
      <key>en</key><string>Scan with GenOffice AI</string>
      <key>vi</key><string>Quét thư mục bằng GenOffice AI</string>
    </dict>
    <key>NSMessage</key><string>runWorkflowAsService</string>
    <key>NSRequiredContext</key><dict>
      <key>NSApplicationIdentifier</key><string>com.apple.finder</string>
    </dict>
    <key>NSSendTypes</key><array><string>NSFilenamesPboardType</string></array>
    <key>NSSendFileTypes</key><array><string>public.folder</string></array>
  </dict></array>
</dict></plist>
`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
