# Codex Usage Remaining

A Visual Studio Code, Cursor, and Windsurf extension that shows how much Codex usage is still available in the 5-hour and weekly usage windows.

## Features

- Remaining usage percentages in the status bar.
- Green, yellow, and red status indicators based on configurable remaining thresholds.
- Progress bars in the status bar tooltip and detailed view.
- Automatic refresh while the editor window is focused.
- Local Codex session discovery under `~/.codex/sessions`.
- Manual refresh and detailed usage panel.

## Status bar

```text
⚡ 🟢 5H: 42% | 🟢 W: 97%
```

- **5H**: remaining usage in the current 5-hour window.
- **W**: remaining usage in the weekly window.
- 🟢: safe remaining usage.
- 🟡: warning threshold reached.
- 🔴: critical threshold reached.
- ⚪: usage data is unavailable.

When a previous window has already reset and no new consumption has been recorded, the extension displays `100%` remaining.

## Commands

- `codex-usage-remaining.refresh` — refresh usage information.
- `codex-usage-remaining.showDetails` — open the detailed usage panel.
- `codex-usage-remaining.openSettings` — open the extension settings.

## Configuration

All settings use the `codexUsageRemaining` namespace:

- `codexUsageRemaining.showOutputOnError` — show the Output panel when an error occurs.
- `codexUsageRemaining.sessionPath` — custom Codex sessions directory. The default is `~/.codex/sessions`.
- `codexUsageRemaining.refreshInterval` — refresh interval in seconds. Valid range: 5 to 3600.
- `codexUsageRemaining.warningRemainingThreshold` — show a warning at or below this remaining percentage. Default: 30.
- `codexUsageRemaining.criticalRemainingThreshold` — show a critical state at or below this remaining percentage. Default: 10.

## Project structure

```text
src/
├── config.ts        # Settings and threshold evaluation
├── constants.ts     # Extension identifiers and defaults
├── extension.ts     # Activation, commands, and refresh lifecycle
├── presentation.ts  # Status bar, tooltip, and detailed panel rendering
├── types.ts         # Shared data contracts
└── usage.ts         # Codex session discovery and usage parsing
```

## Local development

### Requirements

- Node.js 20 or newer.
- npm.
- VS Code, Cursor, or Windsurf.

### Install dependencies

```bash
npm install
```

### Type-check and bundle

```bash
npm run compile
```

### Watch mode

```bash
npm run watch
```

### Generate a VSIX

```bash
npm run package:vsix
```

The generated file follows this pattern:

```text
codex-usage-remaining-<version>.vsix
```

Install it locally with:

```bash
code --install-extension codex-usage-remaining-<version>.vsix
```

## GitHub Actions release pipeline

The release workflow is located at:

```text
.github/workflows/release-vsix.yml
```

It:

1. Resolves the target version from the pushed tag, manual release tag, or `package.json`.
2. Synchronizes the package version during the workflow run.
3. Installs dependencies with `npm install`.
4. Type-checks and bundles the extension.
5. Generates the VSIX.
6. Uploads the VSIX as a workflow artifact.
7. Creates or updates a GitHub Release when requested.

### Create a release from a tag

Both `v0.0.3` and `0.0.3` are accepted:

```bash
git checkout main
git pull
git tag v0.0.3
git push origin v0.0.3
```

A `v0.0.3` tag generates:

```text
codex-usage-remaining-0.0.3.vsix
```

### Run manually

1. Open **Actions** in GitHub.
2. Select **Build and Release VSIX**.
3. Select **Run workflow**.
4. Enable release creation when a GitHub Release is required.
5. Enter the target semantic version in **Release tag**, such as `v0.0.3`.

When the release tag is empty, the workflow uses the version from `package.json`.

## How usage is calculated

Codex session files provide consumed percentages. The extension converts them to remaining percentages:

```text
remaining_percent = 100 - used_percent
```

Session files are read from the most recent seven calendar days, ordered by modification time, and the newest valid `token_count` event is used.

## License

MIT License
