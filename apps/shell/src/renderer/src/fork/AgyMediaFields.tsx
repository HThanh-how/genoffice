import { useCallback, useEffect, useRef, useState } from 'react'
import { Dropdown } from '@genoffice/ui'
import { useI18n } from '../locale'
import { agyString } from './agy-strings'
import { agyMediaString } from './agy-media-strings'
import { agyConnectionOf, agyPlatformOf, type AgyConnection } from './agy-provider-state'
import { agyEffectiveCliPath, agyMediaModelOptions } from './agy-media-state'
import { fetchAgyCatalog } from './AgyProviderFields'

interface Props {
  /** field this block edits: image generation or analysis model */
  modelField: 'imageModel' | 'analysisModel'
  config: { cliPath?: string | undefined; imageModel: string; analysisModel: string }
  /** model ids from the provider catalog (seed until the live list loads) */
  seedModels: string[]
  defaultModel: string
  /** the AI Model pane's agy path, shared when this block has no override */
  chatCliPath: string | undefined
  update(patch: { cliPath?: string; imageModel?: string; analysisModel?: string }): void
  idPrefix: string
}

/**
 * Settings → AI Media & Search block for the Antigravity CLI: connection status, CLI path, model
 * and an honest note. "Test connection" only lists models (`agy models`), so it costs no quota.
 */
export function AgyMediaFields({
  modelField,
  config,
  seedModels,
  defaultModel,
  chatCliPath,
  update,
  idPrefix,
}: Props) {
  const { lang, t } = useI18n()
  const effective = agyEffectiveCliPath(config.cliPath, chatCliPath)
  const [connection, setConnection] = useState<AgyConnection>({ state: 'checking' })
  const [live, setLive] = useState<string[]>([])
  const failureRef = useRef('')
  failureRef.current = agyString(lang, 'agyTestFailed')
  const seq = useRef(0)

  const check = useCallback(async (path: string | undefined) => {
    const mine = ++seq.current
    setConnection({ state: 'checking' })
    try {
      const catalog = await fetchAgyCatalog(path)
      if (mine !== seq.current) return
      setConnection(agyConnectionOf(catalog, failureRef.current))
      setLive(catalog && !catalog.error ? catalog.models : [])
    } catch (error) {
      if (mine !== seq.current) return
      setConnection({
        state: 'missing',
        error: error instanceof Error ? error.message : failureRef.current,
      })
    }
  }, [])

  useEffect(() => {
    void check(effective)
    // first mount only: later path edits re-check on blur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = config[modelField] || defaultModel
  const models = agyMediaModelOptions(live, seedModels, config[modelField])
  const platform = agyPlatformOf(navigator.userAgent)
  const where = agyString(lang, platform === 'win' ? 'agyWhereWin' : 'agyWhereMac')
  return (
    <>
      <div className="set-field-desc set-ai-note">
        {agyMediaString(lang, 'agyMediaHint')} {agyMediaString(lang, 'agyMediaLimits')}
      </div>
      <div className="set-field-desc set-model-discovery" aria-live="polite">
        <span>
          {connection.state === 'checking'
            ? agyString(lang, 'agyChecking')
            : connection.state === 'connected'
              ? agyMediaString(lang, 'agyMediaTestOk', { n: connection.count })
              : agyString(lang, 'agyNotFound', { error: connection.error })}
        </span>
        <button
          className="set-btn"
          type="button"
          disabled={connection.state === 'checking'}
          onClick={() => void check(effective)}
        >
          {agyMediaString(lang, 'agyMediaTest')}
        </button>
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiModelId')}</label>
        </div>
        <Dropdown
          className="set-dd"
          value={selected}
          ariaLabel={t('setAiModelId')}
          options={models.map((m) => ({ value: m, label: m }))}
          onPick={(m) => update({ [modelField]: m })}
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor={`${idPrefix}-agy-path`}>
              {agyString(lang, 'agyPathLabel')}
            </label>
            <div className="set-field-desc">
              {agyMediaString(lang, 'agyMediaPathHint', { where })}
            </div>
          </div>
        </div>
        <input
          id={`${idPrefix}-agy-path`}
          className="set-input"
          type="text"
          value={config.cliPath ?? ''}
          placeholder={
            chatCliPath?.trim()
              ? agyMediaString(lang, 'agyMediaPathPlaceholderShared', { path: chatCliPath.trim() })
              : agyString(lang, 'agyPathPlaceholder')
          }
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => update({ cliPath: e.target.value.trim() })}
          onBlur={(e) => void check(agyEffectiveCliPath(e.target.value, chatCliPath))}
        />
      </div>
    </>
  )
}
