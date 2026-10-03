import { useEffect, useRef, useState } from 'react'
import { Dropdown } from '@genoffice/ui'
import {
  MAX_INSTRUCTIONS_CHARS,
  REPLY_LANGUAGES,
  type AiInstructionsState,
  type ReplyLanguage,
} from '../../../shared/fork/ai-instructions-meta'

const COPY = {
  en: {
    title: 'AI replies & instructions',
    hint: 'Applies to every AI conversation, in every app.',
    language: 'Always reply in',
    languageHint: 'The AI answers in this language whatever language you write in.',
    auto: 'Automatic (follow each app)',
    instructions: 'My instructions',
    instructionsHint:
      'Plain sentences, one rule per line. Saved in a file you can also edit in any editor.',
    save: 'Save',
    saved: 'Saved',
    openFile: 'Open file in editor',
    reload: 'Reload from file',
    chars: '{n} / {max}',
    placeholder: 'For example:\n- Address me as “anh”.\n- Keep answers short.',
  },
  vi: {
    title: 'Trả lời & chỉ dẫn của AI',
    hint: 'Áp dụng cho mọi cuộc trò chuyện với AI, ở mọi ứng dụng.',
    language: 'Luôn trả lời bằng',
    languageHint: 'AI trả lời bằng ngôn ngữ này dù bạn viết bằng tiếng nào.',
    auto: 'Tự động (theo từng ứng dụng)',
    instructions: 'Chỉ dẫn của tôi',
    instructionsHint:
      'Viết câu thường, mỗi dòng một quy tắc. Được lưu trong một tệp, bạn cũng sửa được bằng trình soạn thảo bất kỳ.',
    save: 'Lưu',
    saved: 'Đã lưu',
    openFile: 'Mở tệp trong trình soạn thảo',
    reload: 'Nạp lại từ tệp',
    chars: '{n} / {max}',
    placeholder: 'Ví dụ:\n- Gọi tôi là “anh”.\n- Trả lời ngắn gọn.',
  },
}

export function aiInstructionsTitle(lang: string): { title: string; hint: string } {
  const c = lang === 'vi' ? COPY.vi : COPY.en
  return { title: c.title, hint: c.hint }
}

/** Settings block: the language the AI always answers in, and the person's own instructions file. */
export function AiInstructionsSettings({ lang }: { lang: string }) {
  const c = lang === 'vi' ? COPY.vi : COPY.en
  const api = window.aiOffice
  const [state, setState] = useState<AiInstructionsState | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const noteTimer = useRef<number | undefined>(undefined)

  const apply = (next: AiInstructionsState) => {
    setState(next)
    setText(next.text)
  }
  useEffect(() => {
    let alive = true
    void api.getAiInstructions?.().then((next) => {
      if (alive && next) apply(next)
    })
    return () => {
      alive = false
      window.clearTimeout(noteTimer.current)
    }
  }, [api])

  if (!state) return null
  const dirty = text !== state.text
  const say = (message: string) => {
    setNote(message)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(''), 2000)
  }
  return (
    <>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{c.language}</div>
            <div className="set-field-desc">{c.languageHint}</div>
          </div>
        </div>
        <Dropdown
          className="set-dd"
          value={state.language}
          ariaLabel={c.language}
          options={[
            ...REPLY_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
            { value: 'auto', label: c.auto },
          ]}
          onPick={(value) => {
            setState({ ...state, language: value as ReplyLanguage })
            void api.setAiReplyLanguage(value as ReplyLanguage).then(setState)
          }}
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{c.instructions}</div>
            <div className="set-field-desc">{c.instructionsHint}</div>
            <textarea
              className="set-instructions"
              value={text}
              rows={8}
              spellCheck={false}
              placeholder={c.placeholder}
              aria-label={c.instructions}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="set-instructions-bar">
              <button
                type="button"
                className="set-btn"
                disabled={!dirty}
                onClick={() =>
                  void api.setAiInstructionsText(text).then((next) => {
                    setState(next)
                    say(c.saved)
                  })
                }
              >
                {c.save}
              </button>
              <button
                type="button"
                className="set-btn"
                onClick={() => void api.openAiInstructionsFile()}
              >
                {c.openFile}
              </button>
              <button
                type="button"
                className="set-btn"
                onClick={() => void api.getAiInstructions().then(apply)}
              >
                {c.reload}
              </button>
              <span className="set-field-desc" role="status">
                {note ||
                  c.chars
                    .replace('{n}', String(text.length))
                    .replace('{max}', String(MAX_INSTRUCTIONS_CHARS))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
