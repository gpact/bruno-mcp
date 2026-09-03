# Bruno MCP

Bruno MCP is a local [Model Context Protocol](https://modelcontextprotocol.io/)
server for discovering, inspecting, and executing
[Bruno](https://www.usebruno.com/) API collections. It gives MCP clients a
semantic interface to Bruno collections while delegating request execution,
authentication, scripting, assertions, and environment resolution to the Bruno
CLI.

The discovery and inspection tools do not modify collection files. Request
execution is delegated to Bruno and can run collection scripts with side
effects. The server communicates with an MCP host over standard input and
standard output (stdio).

> **Unofficial project:** Bruno MCP is an independent, unofficial MCP server.
> This project is not affiliated with, endorsed by, sponsored by, or otherwise
> associated with Bruno or its creators. Bruno and related names, logos, and
> marks are trademarks of their respective owners. References to Bruno are used
> solely to describe compatibility with the Bruno software.

## Requirements

- Node.js 22 or newer
- npm
- Bruno CLI `>= 4.0.0 && < 5.0.0`

Bruno MCP validates `bru --version` at startup. Stable Bruno CLI 4.x releases
are supported; prerelease and other major versions are rejected.

## OpenCollection support

Bruno MCP supports Bruno v4 OpenCollection collections identified by an
`opencollection.yml` file. It discovers requests and environments represented by
OpenCollection YAML files.

Legacy `.bru` collections are not supported. Request discovery ignores `.bru`
files rather than parsing or converting them.

## Installation

Install Bruno MCP globally from npm:

```sh
npm install --global @gpact/bruno-mcp
```

Install a supported Bruno CLI separately if it is not already available:

```sh
npm install --global @usebruno/cli@^4.0.0
```

Confirm that both entry points resolve:

```sh
command -v bruno-mcp
bru --version
```

`bruno-mcp` has no command-line options, so invoking it starts the stdio server
rather than printing help. MCP hosts normally start it for you.

To install from a repository checkout instead:

```sh
npm ci
npm run build
npm link
```

## MCP host configuration

The [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
defines how a host launches a server subprocess and exchanges messages over
stdin and stdout. It does not define a universal host configuration file.

Configure your host to run the `bruno-mcp` entry point as a local stdio server
and pass `BRUNO_MCP_ROOT` in the child process environment. Use an absolute root
path because hosts do not all use the same working directory.

### Hosts using `mcpServers`

Claude Desktop and Claude Code project configuration use an `mcpServers` object:

```json
{
  "mcpServers": {
    "bruno": {
      "command": "bruno-mcp",
      "env": {
        "BRUNO_MCP_ROOT": "/home/user/bruno"
      }
    }
  }
}
```

See the official [local server guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for
configuration locations and scope options.

### Visual Studio Code

VS Code uses a `servers` object in its `mcp.json` configuration:

```json
{
  "servers": {
    "bruno": {
      "type": "stdio",
      "command": "bruno-mcp",
      "env": {
        "BRUNO_MCP_ROOT": "/home/user/bruno"
      }
    }
  }
}
```

See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
for workspace and user configuration locations.

### OpenCode

OpenCode uses a local MCP entry under `mcp`, represents the command as an array,
and names the environment field `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bruno": {
      "type": "local",
      "command": ["bruno-mcp"],
      "environment": {
        "BRUNO_MCP_ROOT": "/home/user/bruno"
      }
    }
  }
}
```

See the [OpenCode MCP server documentation](https://opencode.ai/docs/mcp-servers/)
for configuration precedence and additional local server options.

Other hosts may use another schema or a command-line setup flow. In every case,
the required concepts are the same: a local stdio transport, the `bruno-mcp`
command, and the environment variables described below. If a GUI host cannot
find `bruno-mcp` or `bru` on its `PATH`, use the absolute path reported by
`command -v bruno-mcp` for the server command and set `BRUNO_MCP_BRU` to an
absolute Bruno CLI path.

You can also start the server directly. It will wait for MCP messages on stdin
and write protocol messages to stdout:

```sh
BRUNO_MCP_ROOT=/home/user/bruno bruno-mcp
```

## Configuration

Configuration is supplied through environment variables. Invalid configuration
prevents the server from starting.

| Variable | Default | Description |
| --- | --- | --- |
| `BRUNO_MCP_ROOT` | Current working directory | Existing directory that contains the accessible collections. The path is resolved to its canonical location at startup, and collection access is confined to it. |
| `BRUNO_MCP_BRU` | `bru` | Bruno CLI executable name or path. The executable is invoked directly, never through a shell. |
| `BRUNO_MCP_TIMEOUT_MS` | `120000` | Per-run timeout in milliseconds. It must be a positive integer. Values above `900000` are capped at `900000` (15 minutes). |
| `BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX` | `false` | Permits callers to request Bruno's developer sandbox when true. It does not enable developer mode by default. |
| `BRUNO_MCP_ALLOW_INSECURE` | `false` | Permits callers to disable normal TLS certificate verification for a run when true. It does not disable verification by default. |
| `BRUNO_MCP_MAX_REPORT_BYTES` | `5242880` | Maximum accepted Bruno JSON reporter size in UTF-8 bytes (5 MiB by default). It must be a positive integer. |
| `BRUNO_MCP_LOG_LEVEL` | `info` | Minimum stderr log level: `error`, `warn`, `info`, or `debug`. |

Boolean settings accept `true`, `1`, `yes`, or `on`, and `false`, `0`, `no`, or
`off`, without case sensitivity.

Example with explicit execution policies:

```sh
BRUNO_MCP_ROOT=/home/user/bruno \
BRUNO_MCP_BRU=/usr/local/bin/bru \
BRUNO_MCP_TIMEOUT_MS=180000 \
BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX=false \
BRUNO_MCP_ALLOW_INSECURE=false \
BRUNO_MCP_MAX_REPORT_BYTES=5242880 \
BRUNO_MCP_LOG_LEVEL=info \
bruno-mcp
```

## MCP tools

Collection identifiers are paths relative to `BRUNO_MCP_ROOT`. Request and
environment paths are relative to their collection. Returned URLs and YAML
variables are not interpolated.

### `bruno_list_collections`

Lists Bruno OpenCollection collections available in the configured workspace.
It takes no arguments and returns collection identifiers, names, and
OpenCollection versions.

### `bruno_list_requests`

Lists and searches requests in one Bruno OpenCollection collection. It returns
request paths, names, types, and HTTP methods and URLs when available.

Required input:

- `collection`: collection identifier

Optional filters:

- `query`: case-insensitive substring matched against name, path, and URL
- `method`: case-insensitive exact HTTP method
- `type`: case-insensitive exact request type

### `bruno_search_requests`

Searches requests across all collections in one call. Each result includes its
collection identifier.

Required input:

- `query`: non-empty, case-insensitive substring matched against name, path, and
  URL

Optional `method` and `type` filters use case-insensitive exact matching.

### `bruno_get_request`

Reads a Bruno OpenCollection request and returns normalized metadata plus its
parsed YAML document. Every result includes a stable 22-character `revision`
derived from the exact source. Pass that value to `bruno_update_request` to
prevent stale writes.

Required inputs:

- `collection`: collection identifier
- `request`: request path relative to the collection

Set `responseMode` to `revision` to return only `collection`, `path`, and
`revision`. This compact mode is intended for update preflight calls that do not
need to inspect the request. It defaults to `full`, which returns normalized
metadata and the parsed document. In full mode, set `includeSource` to `true` to
also return the raw YAML source. `includeSource` cannot be combined with revision
mode.

The parsed document and source are returned without secret redaction, so use
request paths produced by the listing or search tools and do not embed
credentials directly in request YAML.

### `bruno_create_request`

Creates a new Bruno v4 OpenCollection HTTP request from structured fields. The
tool creates missing parent directories, but never overwrites an existing file.
The request is available to the listing, search, inspection, and execution tools
immediately after creation.

Required inputs:

- `collection`: collection identifier
- `request`: normalized path relative to the collection, including `.yml`
- `name`: request display name
- `method`: HTTP method
- `url`: request URL, with Bruno variables stored verbatim

Optional inputs cover the full Bruno v4 HTTP request representation:

- Request metadata: `sequence`, `tags`, and `description`
- HTTP details: `headers`, query or path `params`, `body`, and `auth`
- Execution behavior: `runtime` variables, scripts, assertions, and actions
- Additional data: `settings`, `examples`, `docs`, and `app`

Supported bodies include raw JSON, text, XML, and SPARQL content, URL-encoded
forms, multipart forms, and files. A request may provide one body or named body
variants. Authentication supports Bruno's OpenCollection auth types and Bruno's
Akamai EdgeGrid extension. The advertised MCP input schema describes each nested
field and validates incompatible variants. Request YAML is serialized and written
directly; Bruno CLI is not used for file creation.

The path must not target collection metadata, the root `environments` directory,
or a nested collection. Absolute paths, non-normalized paths, unsupported file
extensions, traversal outside the collection, and symlink escapes are rejected.

### `bruno_update_request`

Patches an existing Bruno v4 OpenCollection HTTP request in place. The tool only
accepts valid HTTP request targets and applies the same path and collection
eligibility policies as `bruno_create_request`. Renaming and moving files are not
supported.

Required inputs:

- `collection`: collection identifier
- `request`: normalized request path relative to the collection, including `.yml`
- `expectedRevision`: revision returned by `bruno_get_request`, or `*` to patch
  the latest version without a preliminary read

Every structured field accepted by `bruno_create_request` can be supplied as a
patch. Omitted top-level fields remain unchanged. `runtime`, `settings`, and
`app` are nested patches: omitted children remain unchanged, a child set to
`null` is removed, and supplied child arrays replace their whole arrays. Setting
one of these three top-level fields to `null` removes the whole block. An empty
nested patch is a no-op, while removing its final child leaves an explicit empty
mapping.

All other supplied fields replace their whole value. This includes `auth`,
`body`, structured descriptions, `tags`, `headers`, `params`, and `examples`.
Individual array-entry operations are not supported. `name`, `method`, and `url`
accept only concrete non-blank replacements; `null` removes any other optional
top-level field. A field cannot be removed when doing so would leave an alias
without its YAML anchor; that patch is rejected as an invalid mutation target.

Updates preserve untouched YAML fields, comments, ordering, scalar styles, line
endings, and final-newline state where supported by the YAML document model.
Unknown and unrelated legacy fields are not revalidated or removed. A semantic
no-op returns `changed: false` without rewriting the file. A changed request is
staged beside the original and atomically replaced while preserving its file
mode. If the source no longer matches `expectedRevision`, the tool returns a
`REVISION_CONFLICT` error without applying the patch. Concurrent updates from
Bruno MCP server instances are serialized per request; a currently locked request
returns `MUTATION_CONFLICT`. Locks are short-lived leases. Locks abandoned by a
terminated process are recovered after a grace period, and all locks expire after
24 hours to avoid permanently blocking a request.

When `expectedRevision` is `*`, the server captures the revision after acquiring
the request lock and applies the same commit-time checks used for explicit
revisions. This saves the preflight call and remains guarded against concurrent
Bruno MCP updates. Use an explicit revision when the patch was chosen based on
previously inspected request content. As with explicit revisions, a
non-cooperating process that writes in the final interval between the portable
filesystem check and replacement is outside this coordination guarantee.

### `bruno_list_environments`

Lists environments available to a collection without exposing variable values.
Each result includes the environment name, relative path, variable count, and
secret count.

Required input:

- `collection`: collection identifier

### `bruno_get_environment`

Inspects a Bruno environment. Variables marked `secret: true` are returned with
the value `[REDACTED]`; non-secret values are returned in normalized string
form.

Required inputs:

- `collection`: collection identifier
- `environment`: bare name such as `Local` or a collection-relative path such as
  `environments/Local.yml`

### `bruno_run`

Executes requests, folders, or an entire collection using Bruno CLI v4. It
returns normalized execution, request, response, test, and assertion results.
Bruno test or assertion failures remain inspectable results rather than MCP
transport errors.

Inputs:

| Field | Default | Description |
| --- | --- | --- |
| `collection` | Required | Collection identifier. |
| `targets` | `[]` | Request or folder paths. An empty array runs the entire collection. |
| `environment` | None | Bruno environment name. |
| `variables` | None | Non-secret string overrides passed as Bruno environment variables. |
| `bail` | `false` | Stops after the first failing request, test, or assertion. |
| `testsOnly` | `false` | Runs only requests that contain tests or active assertions. |
| `delayMs` | None | Non-negative delay between requests in milliseconds. |
| `sandbox` | `safe` | Bruno sandbox mode: `safe` or `developer`. |
| `insecure` | `false` | Requests disabled TLS certificate verification. |
| `responseBodyMode` | `onFailure` | Returned response bodies: `none`, `onFailure`, or `full`. |
| `maxResponseBodyBytes` | `262144` | Maximum UTF-8 or serialized size of each included response body. Oversized bodies are replaced by size metadata. |

## Secret handling

> Do not pass credentials or other secrets through `variables`, request creation
> or update fields such as `auth` or `headers`, or other MCP arguments. MCP tool
> arguments may be visible to the model and host. Created and updated request
> fields are also persisted to YAML, and variable overrides are passed to the
> Bruno process as arguments.
> Provide secrets through Bruno's normal environment or process environment
> mechanisms instead.

Environment inspection honors `secret: true`, but this marker is not a general
file-access boundary. `bruno_get_request` returns files without redaction and
currently accepts any existing file inside a collection, not only paths found by
request discovery. An authorized caller that supplies an environment file path
could therefore receive its raw contents. Restrict MCP access to trusted hosts
and users, scope `BRUNO_MCP_ROOT` narrowly, and avoid plaintext production
secrets anywhere an MCP caller can read them.

## Sandbox and TLS policies

`bruno_run` uses Bruno's safe sandbox by default.

Developer sandbox execution requires both of these explicit choices:

1. The server operator sets `BRUNO_MCP_ALLOW_DEVELOPER_SANDBOX=true`.
2. The tool caller sets `sandbox` to `developer` for the run.

Without server permission, a developer-mode request fails with
`DEVELOPER_SANDBOX_DISABLED`. Developer mode gives Bruno scripts greater
capabilities, so enable it only for trusted collections.

Path containment controls paths supplied to Bruno MCP; it does not sandbox code
inside Bruno scripts. Bruno scripts can update collection or environment state,
and developer-mode scripts can use native Node.js capabilities to access paths
outside `BRUNO_MCP_ROOT` or start other processes.

Normal TLS certificate verification is enabled by default. Disabling it also
requires both server permission (`BRUNO_MCP_ALLOW_INSECURE=true`) and
`insecure: true` on an individual run. Otherwise the request fails with
`INSECURE_DISABLED`. Insecure mode weakens transport security and should be
limited to controlled development environments.

## Security model

- **Root containment:** Collection, request, environment, and execution paths
  supplied to Bruno MCP are checked against canonical filesystem boundaries.
  Traversal and symlink escapes outside `BRUNO_MCP_ROOT` or a selected
  collection are rejected. This does not restrict developer-mode script code.
- **No shell execution:** Bruno MCP passes a fixed operation and separate
  arguments directly to the configured Bruno executable with shell execution
  disabled. It does not expose a generic shell or Bruno CLI command tool, but
  developer-mode Bruno scripts can start processes themselves.
- **Controlled request mutation:** Discovery and inspection are read-only.
  `bruno_create_request` uses an exclusive write and never replaces an existing
  path. `bruno_update_request` accepts either the revision returned by inspection
  or an explicit `*` latest-version guard, rejects non-HTTP targets, and atomically
  replaces changed files.
  `bruno_run` delegates to Bruno CLI and can execute scripts with side effects,
  including persisted variable changes.
- **Targeted redaction:** Environment values explicitly marked `secret: true`
  are redacted by environment inspection. Execution reports recursively redact
  common sensitive headers including authorization, cookies, and API key
  headers. Raw file and request reads are not redacted.
- **Protocol-only stdout:** stdout is reserved for MCP protocol traffic. Logs
  and startup diagnostics are written to stderr.
- **Bounded reports:** Oversized Bruno reports are rejected, and included
  response bodies have a separate per-body limit.

Redaction is defense in depth, not general secret detection. Raw files, request
YAML, request source, URLs, response bodies, and Bruno diagnostics can contain
values that are not recognized as secrets. Configure `BRUNO_MCP_ROOT` as
narrowly as practical, avoid embedding credentials in collection files, and use
trusted collections and MCP callers when enabling request execution.

## Development

Install the locked dependencies:

```sh
npm ci
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript entry point in development. |
| `npm run build` | Compile the server to `dist/`. |
| `npm start` | Run the compiled stdio server. |
| `npm run check` | Run all checks required by CI. |
| `npm run lint` | Lint source, tests, and tooling. |
| `npm run typecheck` | Type-check source, tests, and tooling without emitting files. |
| `npm test` | Run the unit test suite once. |
| `npm run test:watch` | Run unit tests in watch mode. |
| `npm run test:integration` | Run the integration test suite. |
| `npm run fixtures:capture-reports` | Regenerate Bruno reporter fixtures when intentionally updating them. |

Before submitting a change, run:

```sh
npm run check
```

## Known limitations

- Only Bruno OpenCollection YAML is supported; legacy `.bru` collections are
  ignored.
- Request creation and in-place HTTP request updates are the only direct MCP
  mutations. Collection, environment, explicit folder, and workspace mutation
  are not supported, and no rename, move, or delete tools are provided. Executed
  Bruno scripts can still have side effects.
- Some valid OpenCollection fields are not executed by Bruno CLI 4.0.0. Creation
  preserves those fields in YAML, but subsequent `bruno_run` behavior remains
  limited by the configured Bruno CLI version.
- OpenAPI import and export are not supported.
- The server does not expose arbitrary Bruno CLI commands or shell execution.
- Only local stdio MCP transport is supported. Remote and HTTP MCP transports
  are not included.
- Automatic secret-manager integration is not included.
- Bruno MCP does not implement its own HTTP client, variable interpolation,
  authentication, OAuth, scripts, request chaining, assertions, proxy behavior,
  redirects, or certificate behavior. Those behaviors are owned by Bruno CLI.
