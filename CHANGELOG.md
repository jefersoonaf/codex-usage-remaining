# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
- Rename command identifiers and settings to match Codex Usage Remaining.
- Split the extension into focused configuration, parsing, presentation, and lifecycle modules.
- Remove unused fields, settings, scripts, and development dependencies.
- Replace consumed-percentage threshold logic with direct remaining-percentage thresholds.
- Add strict TypeScript checks for unused code and incomplete return paths.
- Load current usage windows from the live Codex account, with session files as a visible fallback.
- Modernize the status tooltip and details view with cleaner typography, aligned progress bars, responsive cards, and simplified usage-source wording.
- Remove window-elapsed calculations and indicators from the data model and user interface.
- Add a live reset countdown alongside the absolute reset date in the tooltip and details view.
- Make the tooltip and details view more compact while keeping the remaining-usage progress bars.
- Replace the lifetime Codex app-server process with a short-lived process for each live usage sample so account switches are picked up without restarting the editor.
- Stop live polling and cancel any in-flight Codex query when the editor loses focus, preventing the extension from keeping Codex resources active while ChatGPT desktop login, device pairing, or Remote access is being used.
- Ensure the full spawned Codex process tree is terminated on Windows if graceful shutdown does not complete.
- Reduce the default live refresh interval to 30 seconds, with a minimum of 15 seconds, to lower background contention while keeping usage status current.

## [0.0.1] - 2026-07-08
- First release of Codex Usage Remaining.
- Display 5-hour and weekly limits as remaining usage instead of consumed usage.
- Add colored status bar circles for each remaining usage window.
- Add tooltip and detailed view progress bars.
- Add GitHub Actions workflow to build the VSIX artifact and create GitHub Releases.
