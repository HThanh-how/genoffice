import { AppActionRegistry } from '@genoffice/agent-core/app-control'
import { waitForActionStep } from '@genoffice/ui'

export function docsAppActions(
  print: (signal?: AbortSignal) => Promise<boolean>,
  exportPdf: (signal?: AbortSignal) => Promise<boolean>,
): AppActionRegistry {
  const registry = new AppActionRegistry()
  registry.register({
    id: 'print',
    label: 'aiActionPrint',
    risk: 'confirm',
    teach: true,
    // File → Print is native on macOS and in the shell menu: no invented DOM rectangle.
    steps: [{ label: 'aiActionPrint', event: 'handoff' }],
    async run(_input, signal) {
      if (!(await print(signal)))
        return { status: signal.aborted ? 'cancelled' : 'error', error: 'No document to print' }
      await waitForActionStep(
        { label: 'aiActionHandoff', event: 'observe', selector: '.print-dialog' },
        signal,
      )
      return { status: 'handoff' }
    },
  })
  registry.register({
    id: 'export-pdf',
    label: 'aiActionExportPdf',
    risk: 'confirm',
    teach: true,
    highlightSelector: '.ribbon-tab-file',
    steps: [
      { label: 'aiActionFile', selector: '.ribbon-tab-file', event: 'click' },
      { label: 'aiActionExportPdf', selector: '[data-app-action="export-pdf"]', event: 'click' },
      { label: 'aiActionHandoff', event: 'handoff' },
    ],
    // macOS uses the native File menu. The existing menu handler reports the same completion.
    resolveSteps: () =>
      document.querySelector('.ribbon-tab-file')
        ? [
            { label: 'aiActionFile', selector: '.ribbon-tab-file', event: 'click' },
            {
              label: 'aiActionExportPdf',
              selector: '[data-app-action="export-pdf"]',
              event: 'click',
            },
            { label: 'aiActionHandoff', event: 'handoff' },
          ]
        : [{ label: 'aiActionExportPdf', event: 'handoff' }],
    async run(_input, signal) {
      return { status: (await exportPdf(signal)) ? 'completed' : 'cancelled' }
    },
  })
  return registry
}
