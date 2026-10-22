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
  it('gates merges, ignores model approval and destination fields, and returns the standard cite', async () => {
    const bridge = setup()
    const destination = '/allowed/Combined.docx'
    bridge.fileActionDecide = vi.fn(async () => ({ ok: true, path: destination }))
    const opened = vi.fn(async () => true)
    const capture = vi.fn(() => opened)
    let approve!: (value: boolean) => void
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve
        }),
    )
    const task = createFileManagementSkill(bridge, confirm, capture).executeTool({
      id: 'merge',
      name: 'merge_documents',
      input: {
        sources: ['/allowed/B.md', '/allowed/A.docx'],
        title: 'Combined',
        format: 'docx',
        separator: 'heading',
        destination: '/outside/injected.docx',
        approved: true,
      },
    })
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(bridge.fileActionDecide).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    expect(bridge.fileActionPropose).toHaveBeenCalledWith({
      tool: 'merge_documents',
      sources: ['/allowed/B.md', '/allowed/A.docx'],
      title: 'Combined',
      format: 'docx',
      separator: 'heading',
      outputFolder: undefined,
    })
    approve(true)
    const result = await task
    expect(JSON.parse(result.output)).toMatchObject({
      path: destination,
      cite: 'filenav:///allowed/Combined.docx',
      opened: true,
    })
    expect(capture).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledExactlyOnceWith(destination)
  })

  it('reports a saved merge even when the host declines or fails automatic opening', async () => {
    const bridge = setup()
    bridge.fileActionDecide = vi.fn(async () => ({ ok: true, path: '/allowed/new.md' }))
    const result = await createFileManagementSkill(
      bridge,
      async () => true,
      () => async () => {
        throw new Error('stale conversation')
      },
    ).executeTool({
      id: 'merge',
      name: 'merge_documents',
      input: {
        sources: ['/allowed/a.md', '/allowed/b.md'],
        title: 'new',
        format: 'md',
        separator: 'none',
      },
    })
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, opened: false })
    expect(result.isError).not.toBe(true)
  })
  it('uses MCP filesystem path / source / destination argument shapes', () => {
    expect(FILE_MANAGEMENT_TOOLS.map((tool) => tool.name)).toEqual([
      'create_folder',
      'move_file',
      'delete_file',
      'list_folder',
      'export_pdf',
      'merge_documents',
    ])
    for (const tool of FILE_MANAGEMENT_TOOLS) {
      if (tool.name === 'merge_documents') {
        expect(tool.inputSchema).toMatchObject({
          additionalProperties: false,
          required: ['sources', 'title', 'format', 'separator'],
          properties: { sources: { minItems: 2, maxItems: 20 } },
        })
        continue
      }
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
