# Fork release and auto-update

Normal `main` builds are unsigned. After a successful platform build, the Windows and macOS workflows retain a short-lived CI artifact and publish the same versioned installer, SHA256 checksums, and provenance manifest to the shared GitHub Release. Publishing is limited to `main`; dispatches on other branches only produce CI artifacts. These builds do not contain `app-update.yml` and never install an update automatically.

Before merging a release to `main`, bump `apps/shell/package.json` and its lockfile entry to an unused version. Both platform manifests must identify the same commit and version. The publishing script refuses to replace an existing tag pointing to another commit. Windows and macOS publish independently, so verify that both platform builds succeeded and both sets of assets are present before announcing a release.

A signed release is built only from a matching version tag pushed to `release-updates.yml`. Before merging a version intended for signing, set the repository Actions variable `GENOFFICE_SIGNED_RELEASES` to `true`. This keeps the `main` workflows' CI artifacts but skips unsigned publishing, leaving the version tag unused for the signed workflow. The variable defaults to unsigned publishing when unset; use a fresh version for each release.

Configure these GitHub Actions repository secrets before tagging:

| Platform | Secrets                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| Windows  | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                             |
| macOS    | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

The release workflow checks the tag and credentials before creating a draft. Both builders embed the fork's GitHub Releases provider, upload the installer and matching `latest*.yml`, and verify signing. The release becomes public only when both platform jobs succeed. Never mix an installer with metadata from another build. Keep the same signing identities across releases; changing either identity requires a deliberate migration.

To publish the next signed version, configure the signing secrets and set `GENOFFICE_SIGNED_RELEASES=true` before merging. Bump `apps/shell/package.json` and its lockfile entry to an unused version, merge and verify on `main`, then push a matching version tag. Release assets must include `latest.yml`, `latest-mac.yml`, the signed Windows NSIS installer, and the signed/notarized macOS ZIP and DMG. The ZIP serves macOS updates; the DMG is for first installation.

Users of older unsigned CI installers must manually install the first signed release. Later signed releases are checked in the app shortly after launch and periodically; installation requires the user's explicit restart action. Rollback is a new, higher-version signed release. Do not republish a different build under an existing version.
