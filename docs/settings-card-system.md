# Settings card system

The Appearance card is the first card in General. General's other topic cards and
About already used the same private `SetGroup` header. That existing design is
now shared by all seven Settings tabs.

| Tab / section                                                                                                       | Previous pattern                                                 | Current pattern                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| AI Model: provider, model discovery, key, base URL, output limit                                                    | Loose divided fields below a sticky action bar                   | Provider card, icon tile, subtitle, divided rows; action bar retained                                                 |
| AI Model: custom endpoints, protocol, compatibility, headers, timeout, key environment variable, model declarations | Inline editor with loose fields and stacked advanced inputs      | Same provider card and responsive rows; validation, masking and tri-state controls retained                           |
| AI Model: Antigravity CLI/account fields and chat model list                                                        | Loose provider fields and a plain list heading                   | Provider rows plus a separate model-list card                                                                         |
| AI Media & Search: web search, local file search/reranking, image generation, image analysis, video analysis        | Plain subsection headings and loose fields                       | Five cards with icon headers, status actions and the same provider/key/model/URL rows                                 |
| Opening effects: enabled state and richness                                                                         | Two loose rows                                                   | One settings card with divided rows                                                                                   |
| Opening cards: studio actions, random selection, gallery, groups, search, inline preview                            | Custom studio header and approved gallery                        | Shared card header; gallery, filters, random controls and inline preview retained                                     |
| Opening effects: legacy HTML for each document type                                                                 | Plain disclosure and per-app buttons                             | Foldable card and responsive per-app rows                                                                             |
| General: Appearance                                                                                                 | Private icon-header card                                         | Shared card; language, author, theme, document theme, sidebar position and font-size rows retained                    |
| General: AI replies/instructions; AI panel                                                                          | Private icon-header cards                                        | Shared cards; editor, language selection, spellcheck and sidebar switches retained                                    |
| General: Files & saving                                                                                             | Private icon-header card                                         | Shared card; default association, save folder, folder visibility, autosave and sleeping-tab controls retained         |
| General: Legacy Office files                                                                                        | Private foldable card                                            | Shared foldable card; conversion, converter status, verification and recovery list retained                           |
| General: Opening effects shortcut                                                                                   | Private foldable card                                            | Shared foldable card and navigation action                                                                            |
| General: Privacy & clipboard                                                                                        | Private icon-header card                                         | Shared card; analytics, clipboard suggestions/history and clear action retained                                       |
| General: Document memory, scan, recent documents/location/clear                                                     | Single older card with plain subheadings                         | Separate overview, scan and recent-document cards                                                                     |
| General: Indexing speed, scanned-PDF OCR, search model, indexed folders                                             | Mixed plain headings, option tiles, quota panels and folder list | Shared card headers; specialized radio tiles, quota displays, advanced controls, folder chips and quick-add retained  |
| Integrations: introduction, CLI + skill setup, MCP setup                                                            | Hero panel and numbered plain sections                           | Three icon-header cards; setup instructions, install confirmations, status/version chips and examples retained        |
| Integrations: HTTP server, port, background behavior, client config, advanced endpoints and logs                    | Loose controls inside MCP instructions                           | Shared rows inside the MCP card; code/log panels and disclosure retained                                              |
| Skills: personal/recommended lists, category tabs, import/remove/install, details                                   | Plain pane heading and unframed lists                            | Icon-header list card, responsive actions and divided skill rows                                                      |
| About: version, updates, source editor, release channel, repository                                                 | Private brand-icon card                                          | Shared brand-icon card and responsive fields                                                                          |
| Opening dialogs: card customizer, AI generator, media import                                                        | Separate compact dialog headings and form chrome                 | Shared icon-tile header, subtitle, input chrome, focus rings and divided form groups; preview/editor layouts retained |

## Reuse

Import from
`apps/shell/src/renderer/src/fork/settings-ui/SettingsCard.tsx`.
It imports its own `settings-card.css`, uses the existing suite color tokens and
adds no dependencies or global theme tokens.

- `SettingsCard`: `title`, optional `subtitle`, `icon` (existing line-icon name or
  custom node), optional `action`, `fold`, `className`, and `children`.
- `SettingsCardHeader`: the same heading props for custom dialog headers.
- `SettingsRow`: `label`, optional `description`, `control`, or custom `children`;
  existing div attributes pass through. Rows provide their own hairline dividers.
- `SettingsIcon`: a small set of line icons matching the existing Settings icons.

Card-local spacing variables are `--settings-card-padding`, `--settings-card-gap`
and `--settings-row-height`. Controls stack below their labels at 900px and below.
The existing left navigation retains its 760px horizontal-rail breakpoint.

Card copy lives in `i18n/settings-card/` with a thin
`i18n/strings-settings-card.ts` aggregator. English, Vietnamese, Simplified Chinese
and Traditional Chinese have translations; the other locale shards explicitly
re-export the existing English fallback.
