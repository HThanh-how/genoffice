import { describe, expect, it } from 'vitest'
import {
  QUIET_AFTER_MS,
  quietSeconds,
  reduceRun,
  toolActivityLabel,
  waitStage,
} from '../src/AgyChatBar'

const d = {
  actRead: 'Reading {t}',
  actReadAny: 'Reading a file',
  actWrite: 'Writing {t}',
  actWriteAny: 'Writing a file',
  actCommand: 'Running a command',
  actSearch: 'Searching {t}',
  actSearchAny: 'Searching',
  actBrowse: 'Browsing',
  actWork: 'Working',
}

describe('toolActivityLabel', () => {
  it('turns tool names into plain verbs', () => {
    expect(toolActivityLabel('read_file', 'a.docx', d)).toBe('Reading a.docx')
    expect(toolActivityLabel('view_file', undefined, d)).toBe('Reading a file')
    expect(toolActivityLabel('write_to_file', 'out.md', d)).toBe('Writing out.md')
    expect(toolActivityLabel('replace_file_content', undefined, d)).toBe('Writing a file')
    expect(toolActivityLabel('run_command', 'npm test', d)).toBe('Running a command')
    expect(toolActivityLabel('grep_search', 'invoice', d)).toBe('Searching invoice')
    expect(toolActivityLabel('find_by_name', undefined, d)).toBe('Searching')
    expect(toolActivityLabel('browser_navigate', 'x', d)).toBe('Browsing')
    expect(toolActivityLabel('mystery', 'x', d)).toBe('Working')
    expect(toolActivityLabel(undefined, undefined, d)).toBe('Working')
  })
})

describe('quiet run hint', () => {
  it('appears only after a minute without a step event', () => {
    const start = { runId: 'r', phase: 'start' as const, at: 1_000 }
    let run = reduceRun(null, start)!
    expect(quietSeconds(run, 1_000 + QUIET_AFTER_MS - 1)).toBe(0)
    expect(quietSeconds(run, 1_000 + 75_000)).toBe(75)
    run = reduceRun(run, { runId: 'r', phase: 'tool', tool: 'read_file', target: 'a', at: 70_000 })!
    expect(run.lastAt).toBe(70_000)
    expect(quietSeconds(run, 100_000)).toBe(0)
  })
})

describe('waitStage', () => {
  it('moves through honest stages while the run is silent', () => {
    expect(waitStage(0)).toBe('stageRead')
    expect(waitStage(9_999)).toBe('stageRead')
    expect(waitStage(10_000)).toBe('stageThink')
    expect(waitStage(44_999)).toBe('stageThink')
    expect(waitStage(45_000)).toBe('stageDraft')
    expect(waitStage(149_999)).toBe('stageDraft')
    expect(waitStage(240_000)).toBe('stageLate')
  })
  it('skips the reading stage after a real step', () => {
    expect(waitStage(0, true)).toBe('stageThink')
    expect(waitStage(60_000, true)).toBe('stageDraft')
  })
})
