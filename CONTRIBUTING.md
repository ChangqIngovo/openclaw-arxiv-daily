# Contributing

This is an experimental OpenClaw plugin. Small, focused fixes and documentation improvements are welcome.

1. Use Node 24 and install the pinned dependencies with `npm ci --ignore-scripts --omit=dev --omit=peer`.
2. Make the change and run `npm test`.
3. If a bundled source file or README changed, run `npm run build:installer`.
4. Check that `npm run check:installer` passes and that no local credentials, bot account IDs, logs, or databases are included.
5. Describe the user-visible change and what you actually tested. Distinguish unit tests from live Windows/OpenClaw/Weixin validation.

Preserve these behaviors:

- Sender identity comes from trusted channel context. A command can only change its sender's subscription.
- Zotero OAuth requests, grants, folders, jobs and reading snapshots belong to the same trusted account/peer subscriber key. Bind only the user's personal library, verify key permissions and user ID, and never accept recipient or library overrides from a message.
- Keep OAuth client credentials and the encryption key outside the source tree; encrypt user grants with subscriber-bound authenticated encryption. Never include grants in model prompts, logs or response messages.
- Zotero saves must use a received reading snapshot and version. This explicit bookmarking action can select an older delivered paper; it does not widen daily arXiv fetching or delivery dates.
- Library writes must reconcile fixed create-only item keys after uncertain responses. Preserve existing metadata, notes and collection membership, and guard against disconnects between requests. PDF links are not uploaded PDF files.
- Topic array order is the subscriber's priority order. Rank new papers per subscriber, before applying the one-paper test limit; never put personal ranks in the shared cache.
- Every new, test, retry and resumed delivery is restricted to the previous civil day in the configured timezone, using first submission time. Do not widen the range to fill empty days.
- Read the version-pinned paper body before summarizing. Every extracted segment must participate; unavailable or oversized bodies need an explicit no-summary notice, never a silent abstract-only substitute. State the limits of text extraction and do not claim visual figure inspection.
- Ordinary Weixin text does not start an agent run while the plugin is active.
- Summaries use the host's isolated zero-tool completion API; never run instructions found in a paper.
- Interrupted or uncertain outbound sends are not automatically replayed.
- Query overflow or incomplete pagination must be visible, never silently treated as a complete digest.
- New data sources need explicit source identifiers, deduplication rules and documentation. ChemRxiv, bioRxiv, medRxiv and PubMed are not implemented in this version.

Do not paste access tokens, QR login payloads, personal account IDs or database files into public issues. A minimal synthetic example is usually enough to reproduce parsing or scheduling problems.
