import { useEffect, useState } from 'react'
import { Dropdown } from '@genoffice/ui'
import type { OpeningEffectsState } from '../../../shared/home-api'
import { OpeningCardStudio } from './OpeningCardStudio'
import {
  OPENING_APPS,
  type OpeningApp,
  type OpeningPrefs,
  type OpeningTierChoice,
} from '../../../shared/opening-scenes-meta'

const COPY = {
  en: {
    on: 'On',
    off: 'Off',
    show: 'Animation while a file opens',
    showHint:
      'A scene plays over the tab until the document is on screen, so a half-built editor is never shown.',
    tier: 'How rich the animation is',
    tierHint: 'Automatic lightens it on a modest computer or on battery.',
    tiers: {
      auto: 'Automatic',
      full: 'Rich (60 fps)',
      lite: 'Light (30 fps)',
      minimal: 'Calm (almost still)',
    },
    apps: {
      docs: 'Word (.docx)',
      sheets: 'Excel (.xlsx)',
      slides: 'PowerPoint (.pptx)',
      pdf: 'PDF',
      markdown: 'Markdown',
      html: 'HTML',
    },
    custom: 'My HTML page',
    preview: 'Preview',
    importHtml: 'Import HTML…',
    replaceHtml: 'Replace HTML…',
    remove: 'Remove',
    imported: 'Imported page in use',
    guide:
      'Your own page: any single .html file up to 512 KB (CSS and JavaScript inline, pictures as data: links). It runs with no network. Use {{fileName}}, {{title}}, {{hint}} and {{color}} in the text, or window.GENOFFICE_OPEN in a script. GenOffice adds the fade-out.',
  },
  vi: {
    on: 'Bật',
    off: 'Tắt',
    show: 'Hiệu ứng khi mở tệp',
    showHint:
      'Một cảnh chạy phủ lên tab cho đến khi tài liệu hiện đủ trên màn hình, nên không bao giờ thấy trình soạn thảo dựng dở.',
    tier: 'Độ phong phú của hiệu ứng',
    tierHint: 'Tự động sẽ giảm nhẹ trên máy yếu hoặc khi dùng pin.',
    tiers: {
      auto: 'Tự động',
      full: 'Đầy đủ (60 fps)',
      lite: 'Nhẹ (30 fps)',
      minimal: 'Êm (gần như tĩnh)',
    },
    apps: {
      docs: 'Word (.docx)',
      sheets: 'Excel (.xlsx)',
      slides: 'PowerPoint (.pptx)',
      pdf: 'PDF',
      markdown: 'Markdown',
      html: 'HTML',
    },
    custom: 'Trang HTML của tôi',
    preview: 'Xem thử',
    importHtml: 'Nhập HTML…',
    replaceHtml: 'Đổi HTML…',
    remove: 'Gỡ',
    imported: 'Đang dùng trang đã nhập',
    guide:
      'Trang của riêng bạn: một tệp .html duy nhất, tối đa 512 KB (CSS và JavaScript viết thẳng trong tệp, ảnh dạng liên kết data:). Trang chạy hoàn toàn không có mạng. Dùng {{fileName}}, {{title}}, {{hint}}, {{color}} trong chữ, hoặc window.GENOFFICE_OPEN trong script. GenOffice tự thêm hiệu ứng mờ dần.',
  },
}

/** Settings block: whether to play an opening scene, how rich it is, and which scene each kind of file gets. */
export function OpeningEffectsSettings({ lang }: { lang: string }) {
  const c = lang === 'vi' ? COPY.vi : COPY.en
  const api = window.aiOffice
  const [state, setState] = useState<OpeningEffectsState | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api.getOpeningEffects?.().then((next) => {
      if (alive && next) setState(next)
    })
    return () => {
      alive = false
    }
  }, [api])

  if (!state) return null
  const { prefs, custom } = state
  const save = (next: OpeningPrefs) => {
    const prevState = state
    setState({ ...state, prefs: next })
    setError('')
    void api
      .setOpeningPrefs(next)
      .then((updated) => {
        if (updated) setState(updated)
      })
      .catch((err) => {
        setState(prevState)
        setError(err instanceof Error ? err.message : String(err))
      })
  }
  const importFor = (app: OpeningApp) => {
    setError('')
    const prevState = state
    void api
      .importOpeningHtml(app)
      .then((result) => {
        if (result?.state) setState(result.state)
        if (!result?.ok && result?.error) setError(result.error)
      })
      .catch((err) => {
        setState(prevState)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{c.show}</div>
            <div className="set-field-desc">{c.showHint}</div>
          </div>
        </div>
        <Dropdown
          className="set-dd"
          value={prefs.enabled ? 'on' : 'off'}
          ariaLabel={c.show}
          options={[
            { value: 'on', label: c.on },
            { value: 'off', label: c.off },
          ]}
          onPick={(value) => save({ ...prefs, enabled: value === 'on' })}
        />
      </div>
      {!prefs.enabled && (
        <div className="ocs-disabled-banner" role="status">
          <div className="ocs-disabled-banner-text">
            <strong>
              {lang === 'vi'
                ? 'Hiệu ứng mở tệp đang tắt'
                : 'Opening effects are currently turned off'}
            </strong>
            <span>
              {lang === 'vi'
                ? 'Bật hiệu ứng để hiển thị thẻ khi mở tài liệu. Bạn vẫn có thể tùy biến và xem thử thẻ bên dưới.'
                : 'Turn on effects to display cards when documents open. You can still customize and preview cards below.'}
            </span>
          </div>
          <button
            type="button"
            className="set-btn ocs-btn-primary"
            onClick={() => save({ ...prefs, enabled: true })}
          >
            {lang === 'vi' ? 'Bật hiệu ứng ngay' : 'Turn on now'}
          </button>
        </div>
      )}
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{c.tier}</div>
            <div className="set-field-desc">{c.tierHint}</div>
          </div>
        </div>
        <Dropdown
          className="set-dd"
          value={prefs.tier}
          ariaLabel={c.tier}
          options={(['auto', 'full', 'lite', 'minimal'] as OpeningTierChoice[]).map((tier) => ({
            value: tier,
            label: c.tiers[tier],
          }))}
          onPick={(tier) => save({ ...prefs, tier })}
        />
      </div>
      <OpeningCardStudio
        state={state}
        lang={lang}
        onUpdateState={setState}
        onPreview={(app, s) => void api.previewOpening(app, s)}
      />

      <details className="set-opening-advanced">
        <summary>
          {lang === 'vi'
            ? 'Tùy chọn nâng cao (HTML tùy chỉnh cũ)'
            : 'Advanced (Legacy Custom HTML)'}
        </summary>
        <div style={{ marginTop: '12px' }}>
          <div className="set-field-desc set-opening-guide">{c.guide}</div>
          {OPENING_APPS.map((app) => (
            <div className="set-field set-opening-row" key={app} style={{ marginTop: '8px' }}>
              <div className="set-field-text">
                <div className="set-field-stack">
                  <div className="set-field-label">{c.apps[app]}</div>
                  {custom[app] && <div className="set-field-desc">{c.imported}</div>}
                </div>
              </div>
              <div className="set-opening-controls">
                <button
                  type="button"
                  className="set-btn"
                  onClick={() => void api.previewOpening(app, 'custom')}
                >
                  {c.preview}
                </button>
                <button type="button" className="set-btn" onClick={() => importFor(app)}>
                  {custom[app] ? c.replaceHtml : c.importHtml}
                </button>
                {custom[app] && (
                  <button
                    type="button"
                    className="set-btn"
                    onClick={() =>
                      void api
                        .removeOpeningHtml(app)
                        .then((updated) => {
                          if (updated) setState(updated)
                        })
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    }
                  >
                    {c.remove}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </details>
      {error && <div className="set-field-desc set-opening-error">{error}</div>}
    </>
  )
}
