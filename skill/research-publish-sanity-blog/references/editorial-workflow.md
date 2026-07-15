# Editorial workflow

## Audience and voice

Write for readers with basic technical literacy. Use a precise, neutral, professional voice. Explain necessary terms before relying on them. Avoid sales language, hype, artificial urgency, and unsupported superlatives.

## SEO keyword map

Before drafting, derive a bilingual map from the verified fact list:

- Choose one clear **primary keyword** for the actual reader intent in English and one independently natural Chinese equivalent; do not force a literal translation.
- Add 3–6 evidence-backed semantic or long-tail phrases per language, such as established technical terms, realistic use-case wording, protocol names, or limitations that the article truly covers.
- Keep the map private working context. It guides wording; it is not a list to paste into the article or JSON.
- Do not invent search-volume claims, target unrelated terms, repeat a phrase unnaturally, or weaken safety qualifications for SEO.

Use the primary keyword naturally in the title or opening, excerpt, and SEO title when accurate. Spread semantic and long-tail phrases across relevant headings, explanations, examples, and FAQ questions. Use only one or two natural phrases in each SEO description. Preserve technical identifiers, product names, commands, and code exactly.

## Pass one: technical draft

Draft English and Chinese sections from the same fact map. Use this order when evidence supports it:

1. What the technology is and the problem it addresses.
2. How it works and its architecture or data flow.
3. Common use cases and a concrete example.
4. Implementation or code example with prerequisites and limitations.
5. Advantages and trade-offs.
6. Security, privacy, operational, and compatibility considerations.
7. FAQ based on realistic reader questions.
8. Sources/来源.

Do not translate brand names, API identifiers, commands, protocol tokens, or code. Mark pseudocode as pseudocode. Do not present illustrative code as production-ready.

## Pass two: self-polish

Perform a distinct revision after the full draft exists:

- Verify each factual sentence against the claim-to-source list.
- Add missing context needed to interpret a claim safely.
- Delete repetition, filler, vague assertions, and unsupported comparisons.
- Check headings and transitions for a coherent progression.
- Check examples for internal consistency and safe defaults.
- Ensure limitations and security considerations are as visible as benefits.
- Ensure English and Chinese convey the same material facts, qualifications, warnings, and code behavior.
- Check that citations resolve to direct sources and that both language sections list them.
- Check that the primary keyword and related semantic terms improve findability without making either language repetitive or changing any factual claim.

Save only this polished final version. Do not save research notes or a rough draft to the repository.

## Markdown output

Use `assets/blog-draft.template.md` as the shape, not as content. Replace every placeholder. Keep one English half and one Chinese half in the same file. Use fenced code blocks with explicit language identifiers. Local absolute paths and secrets are forbidden.
