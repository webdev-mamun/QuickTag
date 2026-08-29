# QuickTag — agent instructions

Read this before changing anything. `PROJECT-STATUS.md` (also auto-loaded)
covers current state and open decisions; this file covers what the app is and
the rules that constrain how it may be changed.

---

## What this app does

QuickTag is a Shopify embedded app with one job: **archive a product's tags**
(save them off, remove them, apply the shop's archive tags instead) and
**unarchive** them (put them back, remove the archive tags, delete the backup).

The product stays published throughout — only tags change.

---

## Vocabulary rules

Always follow these, in code and in copy.

**1. Merchant-facing text says "archive" / "unarchive" — never "restore."**
The code internally uses `restoreProduct()` and `intent: "restore"` as
identifiers, which is fine. Merchant-visible strings never use that word. The
line is exactly this: a string a merchant can read follows the button; an
identifier does not.

**2. Never say "archive this product."** Shopify already uses that phrase to
mean *unpublish*. The object being archived is always **tags**. "Archive tags"
has no reading in which the product is unpublished; "archive this product" has
no reading in which it isn't.

**3. Archive tags are reserved.** A tag QuickTag applies belongs to QuickTag
even if the product already had it. It is excluded from the backup snapshot and
stripped on unarchive. **This is intentional, not a bug — don't "fix" it.**
Recording which applied tags were pre-existing and sparing those on unarchive is
the obvious change and it is the wrong one: it makes a tag's fate depend on
per-product history the merchant cannot see, so two identical-looking products
would behave differently.

---

## Architecture — three parts, one brain

| Part | Location | Notes |
|---|---|---|
| Embedded app | `app/routes/` | Node + React Router. Settings screen, archived-products list, and the shared API endpoint. |
| Action extension | `extensions/quicktag-action/` | Modal reached via "More actions." No setup needed. |
| Block extension | `extensions/quicktag-block/` | Inline card. Must be pinned by the merchant once. Polls every 10s. |

**Neither extension contains business logic.** Both POST to `/api/quicktag`, and
all archive/unarchive logic lives server-side in
`app/quicktag-archive.server.ts`. Keep it that way — don't let logic leak into
the extensions. Two entry points with their own copies of the sequence would
eventually disagree with each other.

Extensions also *cannot* import from `app/` — they compile to separate bundles
that run on Shopify's infrastructure, not on our server. The transport shim in
`extensions/*/src/quicktag-api.ts` is byte-identical in both by necessity; keep
the two copies in step.

---

## Storage

Everything is Shopify metafields in the app-reserved `$app` namespace (invisible
in the merchant's own metafield UI).

- **Shop-level** archive tag config lives on the app installation.
- **Each archived product's backup** (`savedTags` + `appliedTags`) lives on that
  product. The metafield's *presence* is the archived flag.

Only the `write_products` scope is used — no metafield scope needed.

---

## Safety-critical ordering

**Don't casually reorder this.** It is a correctness contract, not a style.

**Archive:** write the backup and confirm it round-tripped *before* applying
archive tags, and apply archive tags *before* removing the original ones. The
product is never both untagged and unmarked mid-sequence.

**Unarchive:** add saved tags back *before* removing markers, then re-read from
Shopify to verify every saved tag landed *before* deleting the backup. A failed
unarchive must leave the backup intact so retry is always safe.

Case handling is load-bearing too: Shopify dedupes tags case-insensitively but
stores the casing added first. Every comparison is case-insensitive, and every
string handed to `tagsRemove` is the exact string Shopify returned — never the
one the merchant typed.

---

## Known platform limitation

Shopify's native Tags card on the product page **does not repaint after a tag
write until the page is reloaded.** Confirmed by direct testing on a real store,
not assumed — the investigation and the four failed workarounds are written up
in `README.md`.

Because of this, the action modal never auto-closes on success and both
extensions explicitly tell the merchant a refresh is needed. **Don't "fix" this**
by adding auto-close or removing the refresh notice.

---

## Shopify API and platform work

This app is scaffolded from a Shopify app template. See the README for
framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for
all Shopify API and platform work. If missing, install it in the agent host per
that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for
skill-compatible hosts) — do not add tooling to this repo.

Before writing or modifying any Shopify API/platform code (Admin API calls,
metafields, extension targets, webhooks, scopes, API version), check the current
version and current best practice via the Toolkit first — don't rely on prior
training knowledge or existing repo patterns as the source of truth for what's
current.

---

## Where to look before changing things

| Before you change… | Read first |
|---|---|
| Archive/unarchive logic | `app/quicktag-archive.server.ts` — the header explains every design rule above in more depth |
| Merchant-facing copy | `app/quicktag-copy.tsx` — the header documents the vocabulary decisions and why each was settled the way it was |
| Anything, for current state | `PROJECT-STATUS.md` — frozen branches, open decisions |

Both of those source files carry unusually long header comments. They are not
decoration: they record what was tried, what failed, and what must not be
re-litigated. Read them before assuming something is an oversight.
