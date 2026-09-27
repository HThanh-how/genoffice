# Fork release and auto-update

Normal `main` builds are unsigned, short-lived CI artifacts for testing. They do not contain `app-update.yml` and never install an update automatically. A signed release is built only from a `v<apps/shell/package.json version>` tag by `release-updates.yml`.

Configure these GitHub Actions repository secrets before tagging:

| Platform | Secrets                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| Windows  | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                             |
| macOS    | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

The release workflow checks the tag and credentials before creating a draft. Both builders embed the fork's GitHub Releases provider, upload the installer and matching `latest*.yml`, and verify signing. The release becomes public only when both platform jobs succeed. Never mix an installer with metadata from another build. Keep the same signing identities across releases; changing either identity requires a deliberate migration.

To publish the next version, bump `apps/shell/package.json` and its lockfile entry, merge and verify on `main`, then push a matching version tag. Release assets must include `latest.yml`, `latest-mac.yml`, the signed Windows NSIS installer, and the signed/notarized macOS ZIP and DMG. The ZIP serves macOS updates; the DMG is for first installation.

Users of older unsigned CI installers must manually install the first signed release. Later signed releases are checked in the app shortly after launch and periodically; installation requires the user's explicit restart action. Rollback is a new, higher-version signed release. Do not republish a different build under an existing version.
