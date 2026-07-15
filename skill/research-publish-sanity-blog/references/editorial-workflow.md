# Editorial workflow

## Audience and voice

Write for readers with basic technical literacy. Use a precise, neutral, professional voice. Explain necessary terms before relying on them. Avoid sales language, hype, artificial urgency, and unsupported superlatives.

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

Save only this polished final version. Do not save research notes or a rough draft to the repository.

## Markdown output

Use `assets/blog-draft.template.md` as the shape, not as content. Replace every placeholder. Keep one English half and one Chinese half in the same file. Use fenced code blocks with explicit language identifiers. Local absolute paths and secrets are forbidden.
