# QuickTag — Project Status

**Last updated:** 29 August 2026

This file records decisions and state that are **not derivable from the code**.
Everything else lives where it belongs: `QuickTag-Overview.md` for a 3–4 minute
summary, `README.md` for the deep technical reference, `CLAUDE.md` / `AGENTS.md`
for the rules an AI agent working in this repo must follow.

---

## Where the project stands

**V1 is complete and frozen.** Commit `6d293d4` on 29 Aug 2026 is the final V1
state. The `v1` branch was cut from that commit and must stay untouched — it is
the preserved snapshot. All new functionality goes on `main`.

> If you are asked to change V1 behaviour, clarify first: a fix on `main`, or
> genuinely re-cutting the frozen branch? Assume `main` unless told otherwise.

### Outstanding action

Both branches were committed locally but **not yet pushed**. From a terminal
with GitHub credentials:

```
git push origin main
git push -u origin v1
```

If local history looks ahead of the remote, this is why.

---

## Open decision: renaming the app

**Status: undecided.** No rename has been carried out. "QuickTag" is still the
name everywhere.

**The problem.** Every established tag-named Shopify app — Taggify, TagPilot,
Tag Genie, Power Tools Bulk Edit Tags, Pro:Tagger, Simple Bulk Tag Editor — is a
bulk or automated *tagging* tool. "QuickTag" files this app in that category,
which is precisely what it is not. It is reversible archive/restore, and the
speed of tagging is irrelevant to it.

**Shortlist as it stands:**

| Candidate | Case for it | Risk |
|---|---|---|
| **Sideline** *(recommended)* | Names the outcome, not the mechanism — "sideline a product" is out of play, still on the roster, coming back. No collision with Shopify's Archive or with the tag-editor category. | Contains no "tag", so weaker on keyword discovery |
| **TagAside** | Encodes "set aside, still there, retrievable" — the exact sense of *archive* that `quicktag-copy.tsx` uses to justify keeping the verb | The "Tag…" prefix files it back alongside the bulk taggers |
| **Tagkeep** | States the promise plainly | Least distinctive |

**Ruled out: TagVault.** TagVault™ is a trademarked Elevation Lab product.

**Two constraints on any candidate:**

1. **Don't introduce a third verb.** The app settled on archive/unarchive, and
   `app/quicktag-copy.tsx` documents why prose must match the buttons. A name
   like *TagPause* or *TagPark* reopens the vocabulary split that file exists to
   prevent.
2. **Don't collide with Shopify's "archive a product"** (= unpublish). A bare
   *ProductArchive* would recreate at brand level the confusion the copy rules
   fixed at sentence level.

**If a rename goes ahead**, the name touches roughly 27 files in three layers.
Scope it explicitly — these are not all the same decision:

- **Merchant-visible** (must change): the `s-page` heading on Settings, the
  aside panel copy, the Archived-products empty state, both extensions'
  `locales/en.default.json`, `name` in `shopify.app.toml`.
- **Internal identifiers** (optional): `quicktag-*.server.ts` filenames,
  `/api/quicktag`, extension handles, `readQuickTagConfig`. These need not
  follow — the same reasoning the codebase already applies to keeping
  `restoreProduct` while merchants read "unarchive".
- **Docs**: `README.md`, `QuickTag-Overview.md`, this file.

App Store requirement 4.1.2 ("unique, recognizable name that leads with your
distinctive brand identifier … not confusingly similar to another app,
developer, brand, or Shopify product") does not bind today, because distribution
is `SingleMerchant`. Both Sideline and TagAside would satisfy it if that changes.

---

## Documentation map

| Where | What it is | Audience |
|---|---|---|
| `QuickTag-Overview.md` | 3–4 minute summary of what it does and how | Developers, new joiners |
| `README.md` | Full technical reference, including the Tags-card investigation | Developers |
| `CLAUDE.md` → `AGENTS.md` | Rules for AI agents working in this repo | Agents |
| This file | Decisions and state not in the code | Everyone |
| Google Doc — "QuickTag — Product Documentation" | Plain-language explanation for technical *and* non-technical readers, plus a changelog | Stakeholders, PMs |

The Google Doc was intended to carry one tab per version (V1, V2, V3) plus a
Changelog tab. Tabs could not be created programmatically — the Drive API has no
tab support — so it currently holds the two sections as top-level headings, to be
split into tabs by hand.

---

## Standing constraints worth restating

These are enforced in code and explained at length in the file headers, but they
are the three things most likely to be "fixed" by mistake:

1. **Archive tags are reserved.** A tag QuickTag applies belongs to QuickTag,
   even if the product already carried it — it is excluded from the snapshot and
   stripped on unarchive. Deliberate, and stated to the merchant on the Settings
   screen. See the header of `app/quicktag-archive.server.ts` before changing it.
2. **The safety ordering is a contract, not a style.** Archive writes and
   confirms the backup before removing anything; unarchive verifies every saved
   tag returned before deleting the backup. Don't reorder casually.
3. **The refresh notice stays.** Shopify's native Tags card does not repaint
   until the page reloads — confirmed by direct testing on a real store, not
   assumed. The action modal deliberately does not auto-close, and both surfaces
   tell the merchant to refresh. Don't "fix" this.

---

## Current status

- **Distribution:** `SingleMerchant` — a custom app, not listed on the App Store.
- **Hosting:** none. Local development only.
- **To run:** `npm install` → `npm run setup` → `npm run dev`. Requires a `.env`
  (gitignored, not in this repo), Shopify Partner access to the app, and a dev
  store. The app works only while the dev server is running.
- **Scopes:** `write_products` only.
- **API version:** 2026-07.

> **Answering questions about this app does not require running it.** The repo
> and its documentation are self-contained; the dev server adds nothing for that
> purpose.
