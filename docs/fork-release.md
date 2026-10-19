# Fork release and auto-update

Normal `main` builds are unsigned. After a successful platform build, the Windows and macOS workflows retain a short-lived CI artifact and publish the same versioned installer, SHA256 checksums, and provenance manifest to the shared GitHub Release. Publishing is limited to `main`; dispatches on other branches only produce CI artifacts. These builds do not contain `app-update.yml` and never install an update automatically.

Before merging a release to `main`, bump `apps/shell/package.json` and its lockfile entry to an unused version. Both platform manifests must identify the same commit and version. The publishing script refuses to replace an existing tag pointing to another commit. Windows and macOS publish independently, so verify that both platform builds succeeded and both sets of assets are present before announcing a release.

A signed release is built only from a matching version tag pushed to `release-updates.yml`. Before merging a version intended for signing, set the repository Actions variable `GENOFFICE_SIGNED_RELEASES` to `true`. This keeps the `main` workflows' CI artifacts but skips unsigned publishing, leaving the version tag unused for the signed workflow. The variable defaults to unsigned publishing when unset; use a fresh version for each release.

Configure these GitHub Actions repository secrets before tagging:

| Platform | Secrets                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| Windows  | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                             |
| macOS    | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

The release workflow checks the tag and validates platform credentials before creating a private draft release. Platform builds run independently: macOS signing does not depend on Windows credentials, and Windows signing does not depend on macOS credentials. The release remains as a draft until validation succeeds.

For macOS signed releases:

- Full workspace assets are built before packaging: `npm run notices`, `npm run build:all`, and `npm run native:build:universal -w @genoffice/sheets` (which compiles `x86_64-apple-darwin` and `aarch64-apple-darwin` slices and lipo-merges them into a fat sidecar).
- Packaging produces the signed `.app` bundle, `.dmg` installer, and original electron-builder auto-update ZIP (`GenOffice-<version>-arm64-mac.zip` / `latest-mac.yml`).
- Verification via `tools/verify-mac-release.mjs` enforces:
  - Developer ID Application code signing and `AppleTeamID` match (ad-hoc signatures are strictly rejected).
  - Gatekeeper execution assessment (`spctl --assess --type execute`).
  - Notarization ticket stapling on both `.app` and `.dmg`.
  - Feed integrity: original ZIP names preserved, and `latest-mac.yml` file sizes and base64 SHA-512 hashes exactly match assets on disk.
- If validation fails, the release remains in draft state and is never published.
- Only when all enabled platform builds and verifications pass does the publish job mark the release as public (`--draft=false --latest`) and verify update feed presence.

> [!WARNING]
> **Credential Blocker**: macOS signed release and notarization require an active Apple Developer Program membership, a Developer ID Application signing certificate (`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`), App Store Connect API / app-specific credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`), and the organization's `APPLE_TEAM_ID`. As audited, no Apple Developer account or signing secrets are configured on this repository, so signed macOS release publication is currently BLOCKED. Signing must not be faked, unsigned builds must not be published to the signed feed, and Gatekeeper must not be bypassed.

To publish the next signed version once credentials are provided, configure the signing secrets and set `GENOFFICE_SIGNED_RELEASES=true` before merging. Bump `apps/shell/package.json` and its lockfile entry to an unused version (e.g. 0.11.117), merge and verify on `main`, then push a matching version tag. Release assets must include `latest.yml` (for Windows), `latest-mac.yml` (for macOS), the signed Windows NSIS installer, and the signed/notarized macOS ZIP and DMG. The ZIP serves macOS updates; the DMG is for first installation.

Users of older unsigned CI installers must manually install the first signed release. Later signed releases are checked in the app shortly after launch and periodically; installation requires the user's explicit restart action. Rollback is a new, higher-version signed release. Do not republish a different build under an existing version.
