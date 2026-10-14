import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { appConfirm, appMessageBox, appNotify } from '../ui-feedback'
import type {
  IgnorePolicyConfig,
  IgnoreRule,
  IndexPolicyMode,
  IndexingPreset,
} from '../../../shared/fork/document-index-api'
import { studioStrings } from './indexing-rules/studio-strings'
import { OverviewPanel } from './indexing-rules/OverviewPanel'
import { RulesPanel } from './indexing-rules/RulesPanel'
import { RuleEditorModal, type RuleForm } from './indexing-rules/RuleEditorModal'
import { GenOfficeIgnoreEditor } from './indexing-rules/GenOfficeIgnoreEditor'
import {
  isDirtyDraft,
  isEditableRule,
  isSensitivePattern,
  presetStates,
  togglePageSelection,
  toggleSelected,
} from './indexing-rules/policy-ui-state'
import type { RuleFilters, StudioView } from './indexing-rules/policy-ui-types'

function isSensitiveAllow(form: RuleForm): boolean {
  return form.action === 'allow' && isSensitivePattern(form.pattern)
}

export function IndexingRulesStudio({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const d = studioStrings(lang)

  const [view, setView] = useState<StudioView>('overview')
  const [mode, setMode] = useState<IndexPolicyMode>('standard')
  const [rules, setRules] = useState<IgnoreRule[]>([])
  const [fileRules, setFileRules] = useState<IgnoreRule[]>([])
  const [presets, setPresets] = useState<IndexingPreset[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [fileExists, setFileExists] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)

  const [filters, setFilters] = useState<RuleFilters>({
    search: '',
    action: 'all',
    scope: 'all',
    source: 'all',
    state: 'all',
  })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [modalOpen, setModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<IgnoreRule | null>(null)

  const [editorRoot, setEditorRoot] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorOriginal, setEditorOriginal] = useState('')
  const [editorRevision, setEditorRevision] = useState('')
  const [editorExists, setEditorExists] = useState(false)
  const [editorErrors, setEditorErrors] = useState<string[]>([])
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorConflict, setEditorConflict] = useState(false)
  const [syntaxOpen, setSyntaxOpen] = useState(false)

  const mountedRef = useRef(true)
  const loadSeqRef = useRef(0)
  const saveSeqRef = useRef(0)
  const editorLoadSeqRef = useRef(0)
  const editorSaveSeqRef = useRef(0)
  const editorLoadedRootRef = useRef('')
  const editorRootRef = useRef('')
  const lastGoodRef = useRef<IgnorePolicyConfig | null>(null)
  const focusTesterRef = useRef(false)

  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )

  useEffect(() => {
    if (view === 'overview' && focusTesterRef.current) {
      focusTesterRef.current = false
      document.getElementById('ixr-tester-input')?.focus()
    }
  }, [view])

  const loadData = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      let loadedMode: IndexPolicyMode = 'standard'
      let loadedRules: IgnoreRule[] = []
      let loadedPresets: IndexingPreset[] = []
      if (api.getIgnorePolicyConfig) {
        const config = await api.getIgnorePolicyConfig()
        if (seq !== loadSeqRef.current || !mountedRef.current) return
        if (config) {
          loadedMode = config.mode === 'allowlist' ? 'allowlist' : 'standard'
          loadedRules = (config.rules || []).filter((rule) => rule.source !== '.genofficeignore')
          setMode(loadedMode)
          setRules(loadedRules)
        }
      }
      if (api.getPolicyPresets) {
        const presetList = await api.getPolicyPresets()
        if (seq !== loadSeqRef.current || !mountedRef.current) return
        loadedPresets = presetList || []
        setPresets(loadedPresets)
      }
      if (api.getIgnoreRules) {
        const merged = await api.getIgnoreRules()
        if (seq !== loadSeqRef.current || !mountedRef.current) return
        setFileRules((merged || []).filter((rule) => rule.source === '.genofficeignore'))
      }
      if (api.listIndexedFolders) {
        const indexed = await api.listIndexedFolders()
        if (seq !== loadSeqRef.current || !mountedRef.current) return
        const list = (indexed || []).map((folder) => folder.root)
        setRoots(list)
        if (!editorRootRef.current && list.length > 0) {
          editorRootRef.current = list[0]!
          setEditorRoot(list[0]!)
        }
        const status: Record<string, boolean> = {}
        for (const root of list) {
          if (api.getGenOfficeIgnoreFile) {
            try {
              const file = await api.getGenOfficeIgnoreFile(root)
              status[root] = Boolean(file?.exists)
            } catch {
              status[root] = false
            }
          }
        }
        if (seq !== loadSeqRef.current || !mountedRef.current) return
        setFileExists(status)
      }
      lastGoodRef.current = {
        schemaVersion: 1,
        mode: loadedMode,
        rules: loadedRules,
        presets: presetStates(loadedPresets),
      }
    } catch {
      if (mountedRef.current) appNotify(d.loadFailed, 'warning')
    }
  }, [api, d])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const restoreLastGood = () => {
    const good = lastGoodRef.current
    if (!good) return
    setMode(good.mode)
    setRules(good.rules)
    setPresets((current) =>
      current.map((preset) => ({ ...preset, enabled: good.presets[preset.id] !== false })),
    )
  }

  const commitPolicy = async (
    payload: IgnorePolicyConfig,
    successMessage: string,
  ): Promise<boolean> => {
    const seq = ++saveSeqRef.current
    setSaving(true)
    try {
      let res: { ok: boolean; error?: string } | undefined
      if (api.saveIgnorePolicyConfig) {
        res = await api.saveIgnorePolicyConfig(payload)
      } else if (api.saveIgnoreRules) {
        res = await api.saveIgnoreRules(payload.rules)
      }
      if (!mountedRef.current || seq !== saveSeqRef.current) return false
      if (res?.ok) {
        lastGoodRef.current = payload
        appNotify(successMessage, 'success')
        return true
      }
      restoreLastGood()
      appNotify(d.saveFailed, 'error')
      return false
    } catch {
      if (!mountedRef.current || seq !== saveSeqRef.current) return false
      restoreLastGood()
      appNotify(d.saveFailed, 'error')
      return false
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const currentPayload = (
    nextRules: IgnoreRule[],
    nextPresets: IndexingPreset[],
  ): IgnorePolicyConfig => ({
    schemaVersion: 1,
    mode,
    rules: nextRules,
    presets: presetStates(nextPresets),
  })

  const changeMode = (nextMode: IndexPolicyMode) => {
    if (nextMode === mode) return
    setMode(nextMode)
    void commitPolicy(
      { schemaVersion: 1, mode: nextMode, rules, presets: presetStates(presets) },
      d.savedSuccess,
    )
  }

  const togglePreset = (presetId: string, enabled: boolean) => {
    const nextPresets = presets.map((preset) =>
      preset.id === presetId ? { ...preset, enabled } : preset,
    )
    setPresets(nextPresets)
    void commitPolicy(currentPayload(rules, nextPresets), d.savedSuccess)
  }

  const toggleRule = (rule: IgnoreRule) => {
    if (!isEditableRule(rule)) return
    const nextRules = rules.map((entry) =>
      entry.id === rule.id ? { ...entry, enabled: !entry.enabled } : entry,
    )
    setRules(nextRules)
    void commitPolicy(currentPayload(nextRules, presets), d.savedSuccess)
  }

  const deleteRule = async (rule: IgnoreRule) => {
    if (!isEditableRule(rule)) return
    const confirmed = await appConfirm(d.confirmDeleteRule(rule.pattern), {
      title: d.delete,
      confirmLabel: d.delete,
      tone: 'danger',
    })
    if (!confirmed) return
    const nextRules = rules.filter((entry) => entry.id !== rule.id)
    setRules(nextRules)
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(rule.id)
      return next
    })
    void commitPolicy(currentPayload(nextRules, presets), d.savedSuccess)
  }

  const bulkSetEnabled = (enabled: boolean) => {
    // Bulk operations must never touch read-only (.genofficeignore) rules.
    const ids = new Set(
      rules.filter((rule) => selected.has(rule.id) && isEditableRule(rule)).map((rule) => rule.id),
    )
    if (ids.size === 0) return
    const nextRules = rules.map((rule) => (ids.has(rule.id) ? { ...rule, enabled } : rule))
    setRules(nextRules)
    void commitPolicy(currentPayload(nextRules, presets), d.savedSuccess)
  }

  const bulkDelete = async () => {
    const ids = rules
      .filter((rule) => selected.has(rule.id) && isEditableRule(rule))
      .map((rule) => rule.id)
    if (ids.length === 0) return
    const confirmed = await appConfirm(d.confirmBulkDelete(ids.length), {
      title: d.bulkDelete,
      confirmLabel: d.bulkDelete,
      tone: 'danger',
    })
    if (!confirmed) return
    const nextRules = rules.filter((rule) => !ids.includes(rule.id))
    setRules(nextRules)
    setSelected(new Set())
    void commitPolicy(currentPayload(nextRules, presets), d.savedSuccess)
  }

  const openAddRule = () => {
    setEditingRule(null)
    setModalOpen(true)
  }

  const openEditRule = (rule: IgnoreRule) => {
    if (!isEditableRule(rule)) return
    setEditingRule(rule)
    setModalOpen(true)
  }

  const submitRule = async (form: RuleForm) => {
    if (!form.pattern) return
    if (isSensitiveAllow(form)) {
      const ok = await appConfirm(d.sensitiveConfirm, {
        title: d.sensitiveTitle,
        tone: 'warning',
        confirmLabel: d.filterAllow,
      })
      if (!ok) return
    }
    const candidate: IgnoreRule = {
      id: editingRule?.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pattern: form.pattern,
      enabled: editingRule?.enabled ?? true,
      scope: form.scope,
      description: form.description || undefined,
      action: form.action,
      source: 'user',
    }
    const nextRules = editingRule
      ? rules.map((rule) => (rule.id === editingRule.id ? candidate : rule))
      : [candidate, ...rules]
    setModalOpen(false)
    setEditingRule(null)
    setRules(nextRules)
    void commitPolicy(currentPayload(nextRules, presets), d.savedSuccess)
  }

  const openEditorForRoot = async (root: string) => {
    const seq = ++editorLoadSeqRef.current
    editorRootRef.current = root
    editorLoadedRootRef.current = root
    setEditorRoot(root)
    setEditorErrors([])
    setEditorConflict(false)
    try {
      if (api.getGenOfficeIgnoreFile) {
        const file = await api.getGenOfficeIgnoreFile(root)
        // A stale response from an older root request must not overwrite the
        // editor for the root the user is now looking at.
        if (seq !== editorLoadSeqRef.current || !mountedRef.current) return
        setEditorExists(Boolean(file?.exists))
        setEditorContent(file?.content ?? '')
        setEditorOriginal(file?.content ?? '')
        setEditorRevision(file?.revision ?? '')
      }
    } catch {
      if (seq === editorLoadSeqRef.current && mountedRef.current) {
        appNotify(d.loadFailed, 'warning')
      }
    }
  }

  const saveEditor = async (): Promise<boolean> => {
    const submittedRoot = editorRoot
    if (!submittedRoot) return false
    // Snapshot exactly what is being persisted. A response that arrives after
    // the user moved to another root (or reloaded this one) belongs to a file
    // the editor is no longer showing, so it must not touch editor state.
    const submittedContent = editorContent
    const submittedRevision = editorRevision
    const submittedLoadSeq = editorLoadSeqRef.current
    const seq = ++editorSaveSeqRef.current
    const stillEditingSubmittedRoot = () =>
      editorRootRef.current === submittedRoot &&
      editorLoadSeqRef.current === submittedLoadSeq &&
      seq === editorSaveSeqRef.current
    setEditorSaving(true)
    setEditorErrors([])
    setEditorConflict(false)
    try {
      const res = api.saveGenOfficeIgnoreFile
        ? await api.saveGenOfficeIgnoreFile(submittedRoot, submittedContent, submittedRevision)
        : null
      if (!mountedRef.current) return false
      if (res?.ok) {
        // The file for the submitted root now exists regardless of which root
        // the editor is currently displaying.
        setFileExists((prev) => ({ ...prev, [submittedRoot]: true }))
        if (stillEditingSubmittedRoot()) {
          // Only the submitted content is persisted; edits typed while the save
          // was in flight stay dirty.
          setEditorOriginal(submittedContent)
          setEditorRevision(res.revision ?? '')
          setEditorExists(true)
        }
        appNotify(d.editorSaved, 'success')
        void loadData()
        return true
      }
      if (res?.error === 'conflict') {
        if (stillEditingSubmittedRoot()) setEditorConflict(true)
        appNotify(d.editorConflict, 'error')
        return false
      }
      if (stillEditingSubmittedRoot()) {
        setEditorErrors(res?.validationErrors ?? [res?.error ?? d.saveFailed])
      }
      appNotify(d.saveFailed, 'error')
      return false
    } catch (error) {
      if (!mountedRef.current) return false
      if (stillEditingSubmittedRoot()) {
        setEditorErrors([error instanceof Error ? error.message : d.saveFailed])
      }
      appNotify(d.saveFailed, 'error')
      return false
    } finally {
      if (mountedRef.current && seq === editorSaveSeqRef.current) setEditorSaving(false)
    }
  }

  const promptUnsaved = async (): Promise<boolean> => {
    // Returns true when navigation may continue, false when it is cancelled.
    const res = await appMessageBox({
      title: d.editorUnsavedTitle,
      message: d.editorUnsavedMessage,
      buttons: [d.editorSaveBtn, d.editorDiscardBtn, d.editorCancelBtn],
      defaultId: 0,
      cancelId: 2,
      type: 'warning',
    })
    if (res.response === 2) return false
    if (res.response === 1) {
      setEditorContent(editorOriginal)
      return true
    }
    return await saveEditor()
  }

  const requestView = async (next: StudioView): Promise<boolean> => {
    if (next === view) return true
    if (view === 'ignore' && isDirtyDraft(editorContent, editorOriginal)) {
      const allowed = await promptUnsaved()
      if (!allowed) return false
    }
    setView(next)
    if (next === 'ignore') {
      const root = editorRoot || roots[0]
      if (root && editorLoadedRootRef.current !== root) void openEditorForRoot(root)
    }
    return true
  }

  /* Opening a root's file from Overview or the Rules table must go through the
     same unsaved-draft guard as the tab navigation. */
  const openEditorFor = async (root: string) => {
    if (!(await requestView('ignore'))) return
    if (editorRootRef.current !== root) void openEditorForRoot(root)
  }

  const changeEditorRoot = async (root: string) => {
    if (root === editorRoot) return
    if (isDirtyDraft(editorContent, editorOriginal)) {
      const allowed = await promptUnsaved()
      if (!allowed) return
    }
    void openEditorForRoot(root)
  }

  const reloadEditor = async () => {
    if (isDirtyDraft(editorContent, editorOriginal)) {
      const ok = await appConfirm(d.editorReloadConfirm, {
        title: d.editorUnsavedTitle,
        tone: 'warning',
        confirmLabel: d.editorReload,
      })
      if (!ok) return
    }
    editorLoadedRootRef.current = ''
    void openEditorForRoot(editorRoot)
  }

  const insertTemplate = () => {
    setEditorContent(
      editorContent.trim()
        ? `${editorContent.replace(/\n+$/, '')}\n\n# Recommended allowlist template\n!**/*.pdf\n!**/*.docx\n!**/*.xlsx\n!**/*.pptx\n!**/*.md\n!**/*.txt\n!**/*.csv\n`
        : '# GenOffice indexing policy\n@mode allowlist\n\n# Allow common documents\n!**/*.pdf\n!**/*.docx\n!**/*.xlsx\n!**/*.pptx\n!**/*.md\n!**/*.txt\n!**/*.csv\n',
    )
  }

  const displayRules = [...rules, ...fileRules]

  return (
    <div className="ixr">
      <header className="ixr-head">
        <div>
          <h3>{d.title}</h3>
          <p>{d.subtitle}</p>
        </div>
        <div className="ixr-head-actions">
          <button
            type="button"
            className="ixr-btn"
            onClick={() => {
              if (view === 'overview') {
                document.getElementById('ixr-tester-input')?.focus()
                return
              }
              focusTesterRef.current = true
              void requestView('overview')
            }}
          >
            <span>{d.testPath}</span>
          </button>
          <button type="button" className="ixr-btn-primary" onClick={openAddRule}>
            <span>{d.addRule}</span>
          </button>
        </div>
      </header>

      <nav className="ixr-nav" role="tablist" aria-label={d.title}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'overview'}
          className={view === 'overview' ? 'active' : ''}
          onClick={() => void requestView('overview')}
        >
          <span>{d.navOverview}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'rules'}
          className={view === 'rules' ? 'active' : ''}
          onClick={() => void requestView('rules')}
        >
          <span>{d.navRules}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'ignore'}
          className={view === 'ignore' ? 'active' : ''}
          onClick={() => void requestView('ignore')}
        >
          <span>{d.navIgnore}</span>
        </button>
      </nav>

      {view === 'overview' && (
        <OverviewPanel
          strings={d}
          api={api}
          mode={mode}
          presets={presets}
          customRules={rules}
          fileRuleCount={fileRules.length}
          roots={roots}
          fileExists={fileExists}
          saving={saving}
          onModeChange={changeMode}
          onPresetToggle={togglePreset}
          onOpenRules={() => void requestView('rules')}
          onOpenEditor={(root) => void openEditorFor(root)}
        />
      )}

      {view === 'rules' && (
        <RulesPanel
          strings={d}
          rules={displayRules}
          roots={roots}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next)
            setPage(1)
          }}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
          selected={selected}
          onToggleSelect={(id) => setSelected((prev) => toggleSelected(prev, id))}
          onSelectPage={(ids) => setSelected((prev) => togglePageSelection(prev, ids))}
          onClearSelection={() => setSelected(new Set())}
          onBulkEnable={bulkSetEnabled}
          onBulkDelete={() => void bulkDelete()}
          onAddRule={openAddRule}
          onEditRule={openEditRule}
          onDeleteRule={(rule) => void deleteRule(rule)}
          onToggleRule={toggleRule}
          onOpenIgnoreFile={(root) => void openEditorFor(root)}
          saving={saving}
        />
      )}

      {view === 'ignore' && (
        <GenOfficeIgnoreEditor
          strings={d}
          roots={roots}
          root={editorRoot}
          content={editorContent}
          original={editorOriginal}
          exists={editorExists}
          errors={editorErrors}
          saving={editorSaving}
          conflict={editorConflict}
          syntaxOpen={syntaxOpen}
          onSyntaxToggle={() => setSyntaxOpen((open) => !open)}
          onRootChange={(root) => void changeEditorRoot(root)}
          onContentChange={setEditorContent}
          onSave={() => void saveEditor()}
          onReload={() => void reloadEditor()}
          onInsertTemplate={insertTemplate}
        />
      )}

      <RuleEditorModal
        strings={d}
        open={modalOpen}
        rule={editingRule}
        roots={roots}
        onClose={() => {
          setModalOpen(false)
          setEditingRule(null)
        }}
        onSubmit={(form) => void submitRule(form)}
      />
    </div>
  )
}
