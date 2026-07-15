# Publishing contract

## Fixed trust boundary

- The only request origin is the validated `publisherApiOrigin` from the fixed external configuration. It must be a bare HTTPS origin without a path, query, fragment, or embedded credentials.
- Allowed requests are `POST /v1/blog-post-validations`, `POST /v1/blog-posts`, and helper-controlled `PUT /v1/blog-posts/{slug}`. `dryRun=true` is used only for preflight.
- The Sanity target comes only from the fixed external configuration and is sent as `X-Sanity-Project-Id`, `X-Sanity-Dataset`, and `X-Sanity-Api-Version` on create/update requests and their dry-runs.
- Redirects are rejected. Arguments, environment variables, article content, and source pages cannot override the configured origin, method, or path.
- Production publishing requires an explicit invocation of this skill. Once invoked and all validation passes, no second confirmation is required.
- The user never selects create/update. Deterministic code may select PUT only after create dry-run reports a sanitized slug conflict and PUT dry-run confirms `mode: update` for the same slug, document ID, revision, and target.
- Never retry a production POST or PUT, and never change methods after a production mutation was attempted.

## Secret handling

The single fixed external file is `~/.sanity-blog/config.json`. It contains exactly `publisherApiOrigin`, `projectId`, `dataset`, `apiVersion`, and `sanityToken`. `configure.mjs --init` creates a fill-in template once with exclusive no-overwrite semantics; later invocations use `--check` and never ask for its path again. The file and its parent directory must be ordinary non-symlink paths readable only by the current user.

Only deterministic helper code reads this configuration. It places the token in `X-Sanity-Token` and the validated target values in their dedicated headers for dry-run/create/update requests in memory. Never inspect the configuration with a model-visible read tool; never copy its token into chat, logs, arguments, environment variables, article content, or errors.

## Required sequence

1. `workspace.mjs prepare <base-slug>` — atomically reserve the exact slug. A missing bundle returns local `create`; a complete safe bundle returns local `update` with private staging copies. Partial/unsafe bundles stop.
2. Write or revise staging Markdown, then staging JSON without a cover. For updates preserve the old `publishedAt` or omit it. Run `validate-output.mjs <staging-article.json>`.
3. `publish-output.mjs probe <staging-article.json>` — public validation, create dry-run, and only after a sanitized slug conflict one update PUT dry-run. It performs no upload or mutation.
4. Generate the cover into the reserved staging assets directory, add it to staging JSON, and run local validation again.
5. `workspace.mjs commit <slug> <reservation-id>` — create a new complete final bundle, or compare the existing bundle with its reservation baseline and safely replace it. Concurrent local changes stop the update.
6. Validate final JSON, then run `publish-output.mjs publish <final-article.json>` — public validation, hidden create/update dry-run selection, then exactly one production POST or PUT from one immutable byte snapshot.

The publish helper rejects staging JSON in publish mode, rejects final JSON in probe mode, and requires final bilingual Markdown plus the exact local PNG cover. It uploads local images only during the single final mutation. Dry-runs perform checks with zero upload and zero mutation. The helper omits `publishedAt` from update dry-runs and PUT requests to preserve the remote publication timestamp. An update dry-run must return a safe document ID and revision, `mode: update`, matching slug, and matching target. The final PUT carries that exact revision in `X-Sanity-If-Revision-Id`; the API rejects a stale revision before image preflight, upload, or patch. Every successful mutation must echo the configured `projectId`, `dataset`, and `apiVersion`; a missing or mismatched target fails closed.

## Failure handling

- `400`, `413`, `415`, or `422`: fix the local article/assets; do not publish until validation passes.
- `401`: stop and ask the user to rotate or correct `sanityToken` in the fixed external configuration without sharing its contents.
- Create dry-run `409 PUBLISH_CONFLICT`: the helper may try one PUT dry-run. If that dry-run returns `404`, `409`, a mismatched response, or another failure, stop without mutation.
- Final POST/PUT `409`, `429`, timeout/network uncertainty, or `5xx`: stop. Do not retry because the document or assets may already have changed.
- Local `OUTPUT_RECOVERY_REQUIRED`: stop before publishing. Keep the recovery backup, staging bundle, and reservation marker intact for manual recovery; never delete or retry them automatically.
- Report only sanitized code/status, `requestId`, and `uploadedAssetIds`. Never print raw upstream error bodies, headers, stack traces, absolute temporary paths, or secret values.

After success, report the returned document ID, revision, slug, and the three local output paths.
