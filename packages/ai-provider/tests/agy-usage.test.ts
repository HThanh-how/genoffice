import { beforeEach, describe, expect, it } from 'vitest'
import {
  AGY_USAGE_ARGS,
  agyUsageCliMissing,
  readAgyUsage,
  resetAgyUsageSupport,
  type AgyUsageDeps,
} from '../src/agy-usage'

const OK = JSON.stringify({
  status: 'SUCCESS',
  usage: { total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-10-03T14:00:31Z' },
            { window: '5h', remaining_fraction: 0.8, reset_time: '2026-10-01T14:44:25Z' },
          ],
        },
      ],
    },
  },
})

function fakeDeps(run: AgyUsageDeps['run'], calls: string[][] = []): AgyUsageDeps {
  return {
    resolveCli: async () => '/fake/agy',
    run: async (cli, args, timeoutMs) => {
      calls.push([cli, ...args])
      return run(cli, args, timeoutMs)
    },
    now: () => 42,
  }
}

beforeEach(() => resetAgyUsageSupport())

describe('readAgyUsage', () => {
  it('runs the free /usage slash command with a fixed argument vector and parses the table', async () => {
    const calls: string[][] = []
    const reading = await readAgyUsage(
      undefined,
      fakeDeps(async () => OK, calls),
    )
    expect(calls).toEqual([['/fake/agy', ...AGY_USAGE_ARGS]])
    expect(AGY_USAGE_ARGS).toEqual([
      '-p',
      '/usage',
      '--output-format',
      'json',
      '--sandbox',
      '--print-timeout',
      '60s',
    ])
    // never a model, never the dangerous flag
    expect(AGY_USAGE_ARGS).not.toContain('--model')
    expect(AGY_USAGE_ARGS).not.toContain('--dangerously-skip-permissions')
    expect(reading!.readAt).toBe(42)
    expect(reading!.groups[0]!.buckets).toHaveLength(2)
  })

  it('tolerates progress noise around the JSON', async () => {
    const reading = await readAgyUsage(
      undefined,
      fakeDeps(async () => `Fetching...\n${OK}\n`),
    )
    expect(reading).not.toBeNull()
  })

  it('returns null (never throws) when the CLI is missing, fails, times out or prints junk', async () => {
    const missing: AgyUsageDeps = {
      resolveCli: async () => {
        throw new Error('Antigravity CLI (agy) was not found.')
      },
      run: async () => OK,
      now: () => 0,
    }
    expect(await readAgyUsage(undefined, missing)).toBeNull()
    expect(
      await readAgyUsage(
        undefined,
        fakeDeps(async () => {
          throw new Error('Timed out reading Antigravity usage')
        }),
      ),
    ).toBeNull()
    expect(
      await readAgyUsage(
        undefined,
        fakeDeps(async () => 'not json'),
      ),
    ).toBeNull()
    expect(
      await readAgyUsage(
        undefined,
        fakeDeps(async () => '{"status":"SUCCESS"}'),
      ),
    ).toBeNull()
  })

  it('stops asking for the rest of the session if /usage turned out to spend model tokens', async () => {
    const calls: string[][] = []
    const spent = JSON.stringify({
      status: 'SUCCESS',
      response: 'Hello',
      usage: { total_tokens: 16681 },
    })
    const deps = fakeDeps(async () => spent, calls)
    expect(await readAgyUsage(undefined, deps)).toBeNull()
    expect(await readAgyUsage(undefined, deps)).toBeNull()
    expect(calls).toHaveLength(1) // the second call never spawned the CLI
  })
})

describe('a computer with no agy', () => {
  it('says the CLI is missing, and stops saying so once it is there', async () => {
    const missing: AgyUsageDeps = {
      resolveCli: async () => {
        throw new Error(
          'Antigravity CLI (agy) was not found. Install it, or set its full path in Settings → AI Model.',
        )
      },
      run: async () => OK,
      now: () => 42,
    }
    expect(await readAgyUsage(undefined, missing)).toBeNull()
    expect(agyUsageCliMissing()).toBe(true)

    expect(
      await readAgyUsage(
        undefined,
        fakeDeps(async () => OK),
      ),
    ).not.toBeNull()
    expect(agyUsageCliMissing()).toBe(false)
  })

  it('does not call a failed read "missing" when agy is there but broke', async () => {
    await readAgyUsage(
      undefined,
      fakeDeps(async () => {
        throw new Error('agy exited with code 1')
      }),
    )
    expect(agyUsageCliMissing()).toBe(false)
  })
})
