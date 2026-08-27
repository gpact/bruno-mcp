# Bruno JSON reporter captures

These files were captured from `@usebruno/cli` 4.0.0 against the local
OpenCollection fixture and HTTP server in this repository.

Regenerate them from the repository root:

```sh
npm run fixtures:capture-reports
```

The capture script starts the HTTP server at `http://127.0.0.1:4015`, invokes
the installed Bruno CLI without a shell, and replaces the machine-specific
absolute `suitename` prefix with `<fixture>/`. Other reporter fields are kept in
the shape and representation emitted by Bruno.

## Scenarios

| File | Request | Exit code | Reporter file |
| --- | --- | ---: | --- |
| `success.json` | `Health.yml` with `Local` | 0 | Written |
| `failed-assertion.json` | `Failure.yml` with `Local` | 1 | Written |
| `reporter-unavailable.json` | `Health.yml` with `DoesNotExist` | 6 | Not written |

`reporter-unavailable.json` is capture metadata, not a Bruno reporter
document. It records the observed no-report error case and its stderr.

## Observed format

- The report root is an array of iterations. Each iteration contains `results`
  and a `summary`.
- Tests appear in `testResults` with `description`, `status`, and an optional
  `error`. Declarative assertions appear in `assertionResults` with expression,
  operand, operator, status, and optional error fields.
- A JSON response body appears as the parsed value in `response.data`, not as a
  JSON-encoded string. Response metadata includes `status`, headers, timing, and
  size fields.
- A failed check leaves the HTTP result's `status` as `pass`, while the failed
  counts appear in the iteration summary and the process exits with code 1.
- Selecting an unknown environment exits with code 6 and does not create the
  requested reporter file.
