# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-06

### Added

- `bruno_create_request` creates full Bruno v4 OpenCollection HTTP requests from
  structured fields, including authentication, bodies, runtime behavior,
  settings, examples, documentation, and app data.
- Safe request creation with collection-bound path validation, missing parent
  directory creation, nested collection protection, and exclusive no-overwrite
  writes.
- `bruno_update_request` applies guarded, source-preserving patches to existing
  HTTP requests across the full structured request field set.
- Compact source revisions and revision-only responses from
  `bruno_get_request`, semantic no-op detection, optional latest-version updates,
  and atomic request replacement with file-mode preservation.
- Nested patches for request runtime, settings, and app blocks preserve omitted
  sibling fields while replacing explicitly supplied child arrays.
- `bruno_create_environment` creates new Bruno environment files with variable
  definitions, secret markers, and missing directory creation without
  overwriting existing environments.
- `bruno_update_environment` replaces environment variable definitions in place,
  preserving untouched fields, comments, and formatting while enforcing secret
  retention and rejecting secret deletion or renaming.

### Changed

- Compact tool descriptions and simplified schemas across all MCP tools to
  reduce client context and token consumption.

### Security

- Guard `bruno_run` targets and environments against argument injection by
  binding CLI options with `=` syntax, rejecting option-like targets, and
  validating environment names against traversal and symlink escapes.

## [0.1.0] - 2026-08-27

### Added

- MCP tools for listing collections, requests, and environments; reading requests
  and environments; searching across collections; and executing requests through
  Bruno CLI.
- Support for Bruno v4 OpenCollection YAML collections and stable Bruno CLI 4.x
  releases.
- Configuration for workspace roots, Bruno CLI paths, execution timeouts,
  sandbox and TLS policies, report limits, and logging.
- Unit and integration coverage for collection discovery, MCP tools, Bruno CLI
  execution, result normalization, and configuration behavior.

### Security

- Canonical path containment and symlink escape protection for workspace access.
- Direct process execution without a shell, bounded execution reports, targeted
  secret redaction, and explicit opt-in controls for developer sandbox and
  insecure TLS execution.
