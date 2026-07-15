# Article JSON contract

The authoritative runtime validator is the adjacent publisher CLI at `miya-saas/sanity-blog-publisher`. Always run `scripts/validate-output.mjs`; this reference summarizes, but does not replace, that validator.

## Required top-level content

- `title.en` and `title.zh`: non-empty localized titles.
- `slug`: ASCII kebab-case, maximum 96 characters.
- `publishedAt`: current UTC ISO-8601 timestamp for a new article. During an update, preserve the existing value or omit the field so Sanity keeps it.
- `excerpt.en` and `excerpt.zh`: non-empty, each at most 240 characters.
- `body.en` and `body.zh`: non-empty Portable Text arrays.
- `seo.title.en`, `seo.title.zh`, `seo.description.en`, and `seo.description.zh`: all required when SEO is included; each description is at most 180 characters.
- `coverImage`: required by this skill even though the schema permits omission.

Omit `author` unless the user explicitly supplies a published author ID or slug. Never include `_id`; Sanity creates the published document ID.

## SEO keyword placement

The current Sanity schema supports only `seo.title` and `seo.description`; it does not support a `keywords` field. Do not add `seo.keywords`, top-level `keywords`, meta-tag objects, or arbitrary SEO fields—the publisher's strict validator will reject them.

Use the verified bilingual keyword map through content already supported by the schema:

- Put the primary intent phrase naturally in each localized title or opening block when it remains clear and accurate.
- Keep each localized excerpt useful on its own, with relevant terminology rather than a keyword list.
- Make each SEO title specific to the article and each SEO description a readable summary with one or two relevant semantic or long-tail phrases. Descriptions remain limited to 180 characters per language.
- Use related terms only where the body, headings, FAQ, code explanation, or accurate image alt actually discusses them. English and Chinese should target the same intent while using natural local phrasing.

## Cover and images

The cover must use:

```json
{
  "source": {"path": "./assets/example-cover.png"},
  "alt": {"en": "Meaningful English alt text", "zh": "有意义的中文替代文本"}
}
```

Local image paths must be `./assets/<safe-filename>`, stay inside the article assets directory, be real non-symlink raster files, and be no larger than 20 MiB. Remote URLs are forbidden. Existing Sanity images may instead use `source.assetRef` when the publisher accepts the reference. The cover uses localized `alt.en`/`alt.zh`; each body image uses one non-empty `alt` string in its enclosing language body.

## Portable Text

Only these array members are permitted:

- `block`: supported text styles and lists, with span children and optional link mark definitions.
- `image`: a validated local source or existing asset reference plus bilingual alt text.
- `code`: source text with a supported language; use `javascript` only as the default when the language truly is JavaScript.

Keys may be omitted because the publisher deterministically generates stable unique `_key` values. Preserve valid explicit keys when intentionally supplied.

For text blocks, use supported styles such as `normal`, `h2`, `h3`, or `blockquote`. Marks must be schema-supported. Link `href` values must use an allowed safe protocol; set `openInNewTab` explicitly when needed. Never put raw HTML, scripts, iframes, data URLs, or remote image URLs into Portable Text.

Each language body ends with a localized Sources/来源 heading and a list of direct source links. The substantive factual coverage, qualifications, warnings, and code behavior must remain semantically aligned between languages.

## Update semantics

Create/update selection is hidden inside deterministic helpers; the user and model do not pass an update flag. A sanitized create dry-run conflict may be followed by one PUT dry-run, and only a successful `mode: update` response for the same slug and target permits one production PUT.

On update, required fields (`title`, `slug`, `excerpt`, and `body`) are replaced as a complete validated set. For optional `author`, `coverImage`, and `seo`, omission preserves the remote value, `null` removes it, and an object replaces it. This Skill normally regenerates and replaces the cover and SEO while preserving an intentionally retained author. The deterministic request helper omits `publishedAt` from update dry-runs and PUT requests so the remote timestamp is preserved even when a remote collision is discovered after local drafting. The API uses the current Sanity revision as a precondition; revision, draft, Release, ambiguity, or missing-document conflicts stop without retry or fallback to create.
