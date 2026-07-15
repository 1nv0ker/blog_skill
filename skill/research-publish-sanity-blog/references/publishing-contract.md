# Publishing contract

## Fixed trust boundary

- The only origin is `https://publish.miyaip.com`.
- Allowed requests are `POST /v1/blog-post-validations` and `POST /v1/blog-posts`, with `dryRun=true` only for preflight.
- Redirects are rejected. The caller cannot override origin, method, or path.
- Production publishing requires an explicit invocation of this skill. Once invoked and all validation passes, no second confirmation is required.
- Never send PUT or retry a production POST.

## Secret handling

`config.local.json` stores only an absolute `tokenFile` path. The token file must be outside the repository and skill project, be an ordinary non-symlink file, contain one bounded single-line token, and be readable only by the current user. On Windows, the user should verify restrictive ACLs.

Only deterministic helper code reads the token. It places it in `X-Sanity-Token` for dry-run/create requests in memory. Never inspect the token file with a model-visible read tool; never copy the token into chat, logs, arguments, environment variables, article content, or errors.

## Required sequence

1. `workspace.mjs reserve <base-slug>` — atomically reserve a complete local bundle and receive private staging paths, a reservation ID, and `nextStartVersion`.
2. Write staging Markdown, then staging JSON without a cover. Run `validate-output.mjs <staging-article.json>`.
3. `publish-output.mjs probe <staging-article.json>` — public validation followed by one remote dry-run, without upload or mutation.
4. Resolve probe 409 by releasing the exact reservation ID and reserving again with `--start=<nextStartVersion>`; maximum ten total candidates.
5. Generate the cover into the reserved staging assets directory, add it to staging JSON, and run local validation again.
6. `workspace.mjs commit <slug> <reservation-id>` — copy the complete staging bundle to final paths with exclusive no-overwrite semantics, then remove the owned marker/staging directory.
7. Validate the final JSON, then run `publish-output.mjs publish <final-article.json>` — public validation, complete multipart dry-run, then exactly one production create POST from one immutable byte snapshot.

The publish helper rejects staging JSON in publish mode, rejects final JSON in probe mode, and requires the final bilingual Markdown plus exact local PNG cover. It uploads local images only during the final create. Its dry-run performs checks with zero upload and zero mutation.

## Failure handling

- `400`, `413`, `415`, or `422`: fix the local article/assets; do not publish until validation passes.
- `401`: stop and ask the user to rotate or correct the external token file without sharing its contents.
- Probe `409`: select the next `-vN` candidate.
- Final `409`, `429`, timeout/network uncertainty, or `5xx`: stop. Do not retry because the document or assets may already exist.
- Report only sanitized code/status, `requestId`, and `uploadedAssetIds`. Never print raw upstream error bodies, headers, stack traces, absolute temporary paths, or secret values.

After success, report the returned document ID, revision, slug, and the three local output paths.
