import { describe, expect, it, vi } from 'vitest'
import {
  createFileManagementSkill,
  FILE_MANAGEMENT_TOOLS,
  type FileManagementBridge,
  type PendingFileAction,
} from '../src/file-management-skill'

const pending: PendingFileAction = {
  id: 'host-only-token',
  action: { tool: 'delete_file', path: '/allowed/file.md' },
  expiresAt: Date.now() + 60_000,
}
function setup() {
  const bridge: FileManagementBridge = {
    fileActionPropose: vi.fn(async () => ({ pending })),
    fileActionDecide: vi.fn(async (_id, approve) => (approve ? { ok: true } : { denied: true })),
  }
  return bridge
}

describe('file management skill', () => {
  it('uses MCP filesystem path / source / destination argument shapes', () => {
    expect(FILE_MANAGEMENT_TOOLS.map((tool) => tool.name)).toEqual([
      'create_folder',
      'move_file',
      'delete_file',
      'list_folder',
      'export_pdf',
    ])
    for (const tool of FILE_MANAGEMENT_TOOLS) {
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: tool.name === 'move_file' ? ['source', 'destination'] : ['path'],
      })
      expect(Object.keys(tool.inputSchema.properties as object)).toEqual(
        tool.name === 'move_file' ? ['source', 'destination'] : ['path'],
      )
    }
  })

  it('cannot execute while the confirmation card is pending, even with model approval fields', async () => {
    const bridge = setup()
    let decide!: (approved: boolean) => void
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve
        }),
    )
    const skill = createFileManagementSkill(bridge, confirm)
    const result = skill.executeTool({
      id: '1',
      name: 'delete_file',
      input: { path: '/allowed/file.md', approved: true, id: pending.id },
    })
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(bridge.fileActionDecide).not.toHaveBeenCalled()
    expect(bridge.fileActionPropose).toHaveBeenCalledWith(pending.action)
    decide(false)
    expect(await result).toMatchObject({ isError: true })
    expect(bridge.fileActionDecide).toHaveBeenCalledWith(pending.id, false)
  })

  it('passes a single explicit approval and withholds the token from model output', async () => {
    const bridge = setup()
    const result = await createFileManagementSkill(bridge, async () => true).executeTool({
      id: '1',
      name: 'delete_file',
      input: { path: '/allowed/file.md' },
    })
    expect(bridge.fileActionDecide).toHaveBeenCalledWith(pending.id, true)
    expect(result.output).not.toContain(pending.id)
  })

  it('denies cancellation and failed cards; reads never request approval', async () => {
    const bridge = setup()
    const abort = new AbortController()
    const result = await createFileManagementSkill(bridge, async () => {
      abort.abort()
      return true
    }).executeTool(
      { id: '1', name: 'delete_file', input: { path: '/allowed/file.md' } },
      abort.signal,
    )
    expect(result).toMatchObject({ isError: true })
    expect(bridge.fileActionDecide).toHaveBeenLastCalledWith(pending.id, false)
    await createFileManagementSkill(bridge, async () => {
      throw new Error('card closed')
    }).executeTool({
      id: '2',
      name: 'delete_file',
      input: { path: '/allowed/file.md' },
    })
    expect(bridge.fileActionDecide).toHaveBeenLastCalledWith(pending.id, false)
    const confirm = vi.fn()
    bridge.fileActionPropose = vi.fn(async () => ({ result: { entries: [] } }))
    await createFileManagementSkill(bridge, confirm).executeTool({
      id: '3',
      name: 'list_folder',
      input: { path: '/allowed' },
    })
    expect(confirm).not.toHaveBeenCalled()
  })
})
