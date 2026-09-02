# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.1.0]: https://github.com/gpact/bruno-mcp/releases/tag/v0.1.0
