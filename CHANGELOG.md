# Changelog

All notable changes to this action will be documented in this file.

## v1.1.2 — 2025-10-31

### Fixed
- FUNDING.yml now removes old wishlist URLs (GitHub issue URLs and old fulfill URLs) instead of accumulating them. Only the current wishlist URL for the issue is kept in the file.

---

## v1.1.1 — 2025-10-31

### Fixed
- Stale SHA error when updating FUNDING.yml in fork: now re-fetches the file from the fork branch immediately before updating to ensure the SHA matches the latest version.

---

## v1.1.0 — 2025-10-31

### Added
- Concurrency guard in workflow template to prevent parallel runs per issue (`concurrency` grouped by issue number).
- Defensive label check in the action to only proceed when the issue has `approved-wishlist`.
- Logging to show the exact wishlist URL being added to FUNDING.yml for better traceability.

### Changed
- FUNDING.yml URL now uses the fulfill URL format:
  - `https://oss-wishlist.com/oss-wishlist-website/fullfill?issue=<number>`
- PR creation hardened to avoid duplicates:
  - Deterministic branch name per issue (e.g., `add-wishlist-funding-<issue>`)
  - Reuse branch if it exists; reuse PR if it already exists for that branch
  - PR body includes the wishlist URL to enable reliable duplicate detection
- Workflow template now triggers only on `issues.labeled` events and is gated by `approved-wishlist`.
- Repository references updated to `oss-wishlist/manage-wishlist-actions`.

### Fixed
- Duplicate PRs: multiple simultaneous PRs for the same issue caused by randomized branch names and missing PR correlation.
- Incorrect FUNDING.yml link: previously wrote the GitHub issue URL; now writes the fulfill URL.

### Migration
- Existing FUNDING.yml files with old GitHub issue URLs will be auto-migrated to the new fulfill URL format on update.

---

## v1.0.0 — Initial release
- Initial automation for parsing wishlist issues, checking/updating FUNDING.yml, and creating PRs.
