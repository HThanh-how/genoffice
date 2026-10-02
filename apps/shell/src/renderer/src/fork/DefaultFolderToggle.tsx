import { useEffect, useState } from 'react'
import { useI18n } from '../locale'

/** Home listens for this and reloads the Folders tree. */
export const FOLDER_ROOTS_CHANGED_EVENT = 'genoffice:folder-roots-changed'

const EN = {
  label: 'Show the GenOffice folder in Folders',
  desc: 'The folder where new files are saved. Off by default: Folders lists the folders and drives you added, and each of them is indexed.',
}
const VI: typeof EN = {
  label: 'Hiện thư mục GenOffice trong Thư mục',
  desc: 'Thư mục lưu file mới. Mặc định tắt: danh sách chỉ có các thư mục và ổ đĩa anh đã thêm, và mỗi cái đều được index.',
}

/** Settings → General: whether the app's own save folder is listed in the Folders tree. */
export function DefaultFolderToggle() {
  const { lang } = useI18n()
  const w = lang === 'vi' ? VI : EN
  const [on, setOn] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    void window.aiOffice.getShowDefaultFolder?.().then((value) => {
      if (alive) setOn(value === true)
    })
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <div className="set-field-label">{w.label}</div>
          <div className="set-field-desc">{w.desc}</div>
        </div>
      </div>
      <button
        className="set-switch"
        role="switch"
        aria-checked={on}
        aria-label={w.label}
        disabled={saving}
        onClick={() => {
          const next = !on
          setSaving(true)
          void window.aiOffice
            .setShowDefaultFolder(next)
            .then((persisted) => {
              setOn(persisted)
              window.dispatchEvent(new Event(FOLDER_ROOTS_CHANGED_EVENT))
            })
            .catch(() => {})
            .finally(() => setSaving(false))
        }}
      />
    </div>
  )
}
