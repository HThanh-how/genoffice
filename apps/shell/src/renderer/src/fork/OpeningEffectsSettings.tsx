import { useEffect, useState } from 'react'
import { Dropdown } from '@genoffice/ui'
import type { OpeningEffectsState } from '../../../shared/home-api'
import {
  CUSTOM_SCENE,
  OPENING_APPS,
  SCENES,
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
    setState({ ...state, prefs: next })
    void api.setOpeningPrefs(next).then(setState)
  }
  const sceneOptions = (app: OpeningApp) => [
    ...SCENES.map((s) => ({ value: s.id, label: lang === 'vi' ? s.vi : s.en })),
    ...(custom[app] ? [{ value: CUSTOM_SCENE, label: c.custom }] : []),
  ]
  const importFor = (app: OpeningApp) => {
    setError('')
    void api.importOpeningHtml(app).then((result) => {
      setState(result.state)
      if (!result.ok && result.error) setError(result.error)
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
      {prefs.enabled && (
        <>
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
          {OPENING_APPS.map((app) => (
            <div className="set-field set-opening-row" key={app}>
              <div className="set-field-text">
                <div className="set-field-stack">
                  <div className="set-field-label">{c.apps[app]}</div>
                  {custom[app] && <div className="set-field-desc">{c.imported}</div>}
                </div>
              </div>
              <div className="set-opening-controls">
                <Dropdown
                  className="set-dd set-dd-wide"
                  value={prefs.scenes[app]}
                  ariaLabel={c.apps[app]}
                  options={sceneOptions(app)}
                  onPick={(scene) => save({ ...prefs, scenes: { ...prefs.scenes, [app]: scene } })}
                />
                <button
                  type="button"
                  className="set-btn"
                  onClick={() => void api.previewOpening(app, prefs.scenes[app])}
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
                    onClick={() => void api.removeOpeningHtml(app).then(setState)}
                  >
                    {c.remove}
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="set-field-desc set-opening-guide">{c.guide}</div>
          {error && <div className="set-field-desc set-opening-error">{error}</div>}
        </>
      )}
    </>
  )
}
