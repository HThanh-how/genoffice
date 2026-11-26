import { useEffect, useState } from 'react'
import type { AiProviderConfig } from '@genoffice/ai-provider/browser'
import { localOptions } from '@genoffice/local-llm/protocol'
import { LFM_MANIFEST } from '@genoffice/local-llm/manifest'
import type { LocalModelState } from '../../../shared/local-model'
import { useI18n } from '../locale'
import { localChatCopy } from '../i18n/strings-local-chat'
import { SettingsCard, SettingsRow } from './settings-ui/SettingsCard'

export function LocalModelSettings({
  config,
  update,
}: {
  config: AiProviderConfig
  update(patch: Partial<AiProviderConfig>): void
}) {
  const { lang } = useI18n()
  const c = localChatCopy(lang)
  const options = localOptions(config.local)
  const [state, setState] = useState<LocalModelState>({ status: 'checking', percent: 0 })
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = () =>
      window.aiOffice.localModelStatus().then(
        (next) => {
          if (alive) setState(next)
        },
        (error) => {
          if (alive) setState({ status: 'error', percent: 0, error: String(error) })
        },
      )
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const patch = (value: Partial<typeof options>) => update({ local: { ...options, ...value } })
  const action = async (value: 'download' | 'cancel' | 'delete') => {
    setPending(true)
    try {
      setState(await window.aiOffice.localModelAction(value))
    } catch (error) {
      setState({ status: 'error', percent: state.percent, error: String(error) })
    } finally {
      setPending(false)
    }
  }
  return (
    <SettingsCard title={c.title} subtitle="LFM3-VL-2B · Q4_K_M · 1.10 GB">
      <div role={state.status === 'error' ? 'alert' : 'status'} aria-live="polite">
        {/* an error with a message needs no heading saying "Error" */}
        {state.status === 'error' && state.error
          ? state.error
          : c[state.status].replace('{n}', String(state.percent))}
      </div>
      {state.status === 'downloading' && (
        <progress
          value={state.percent}
          max={100}
          aria-label={c.downloading.replace('{n}', String(state.percent))}
        />
      )}
      {/* no value: the check is running and cannot say how far it is */}
      {state.status === 'verifying' && <progress aria-label={c.verifying} />}
      {state.error && state.status !== 'error' && (
        <p className="set-field-desc" role="status">
          {state.error}
        </p>
      )}
      <SettingsRow>
        {state.status === 'downloading' || state.status === 'verifying' ? (
          <button className="set-btn" disabled={pending} onClick={() => void action('cancel')}>
            {c.cancel}
          </button>
        ) : (
          state.status !== 'ready' && (
            <button
              className="set-btn"
              disabled={pending || state.status === 'checking'}
              onClick={() => void action('download')}
            >
              {state.status === 'paused' ? c.resume : c.download}
            </button>
          )
        )}
        <button
          className="set-btn"
          disabled={pending || state.status === 'checking' || state.status === 'missing'}
          onClick={() => void action('delete')}
        >
          {c.remove}
        </button>
      </SettingsRow>
      <p className="set-field-desc">{c.limits}</p>
      <p className="set-field-desc">{c.license}</p>
      <a
        href={LFM_MANIFEST.license.url}
        onClick={(event) => {
          event.preventDefault()
          void window.aiOffice.localModelLicense()
        }}
      >
        {LFM_MANIFEST.license.name}
      </a>
      <SettingsRow
        label={<label htmlFor="local-hot">{c.keepHot}</label>}
        control={
          <input
            id="local-hot"
            className="set-input"
            type="number"
            min={0}
            max={120}
            value={options.keepHotMinutes}
            onChange={(event) => patch({ keepHotMinutes: Number(event.target.value) })}
          />
        }
      />
      <SettingsRow
        label={<label htmlFor="local-thinking">{c.thinking}</label>}
        control={
          <input
            id="local-thinking"
            type="checkbox"
            checked={options.thinking}
            onChange={(event) => patch({ thinking: event.target.checked })}
          />
        }
      />
      <SettingsRow
        label={<label htmlFor="local-auto">{c.autoDownload}</label>}
        control={
          <input
            id="local-auto"
            type="checkbox"
            checked={options.autoDownload}
            onChange={(event) => patch({ autoDownload: event.target.checked })}
          />
        }
      />
      <details>
        <summary>{c.advanced}</summary>
        <SettingsRow
          label={<label htmlFor="local-threads">{c.threads}</label>}
          control={
            <input
              id="local-threads"
              className="set-input"
              type="number"
              min={1}
              max={64}
              value={options.threads}
              onChange={(event) => patch({ threads: Number(event.target.value) })}
            />
          }
        />
        <SettingsRow
          label={<label htmlFor="local-gpu">{c.gpu}</label>}
          control={
            <select
              id="local-gpu"
              className="set-input"
              value={options.gpu}
              onChange={(event) => patch({ gpu: event.target.value as typeof options.gpu })}
            >
              {['cpu', 'auto', 'vulkan'].map((gpu) => (
                <option key={gpu} value={gpu}>
                  {gpu}
                </option>
              ))}
            </select>
          }
        />
        <p className="set-field-desc">{c.gpuWarning}</p>
        <SettingsRow
          label={<label htmlFor="local-context">{c.context}</label>}
          control={
            <select
              id="local-context"
              className="set-input"
              value={options.contextSize}
              onChange={(event) => patch({ contextSize: Number(event.target.value) })}
            >
              {[2048, 4096, 8192, 16384, 32768].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          }
        />
      </details>
    </SettingsCard>
  )
}
