# QuickTag

Archives a product's tags — saves them, takes them off, puts the shop's archive
tags on instead — and unarchives to put them back. From the product details page
in the Shopify admin.

Custom (unlisted) embedded app, built on the Shopify CLI React Router template.
Local development only — there is no hosting or deployment config here.

---

## What runs where

This is the part worth internalising, because it explains almost every design
decision in the codebase.

| Piece | Code | Runs on |
| --- | --- | --- |
| Settings screen | `app/routes/app._index.tsx` | **Your machine.** React Router server + a browser iframe inside the admin. |
| Archived products screen | `app/routes/app.managed.tsx` | **Your machine.** Same split. |
| Archive / unarchive sequences | `app/quicktag-archive.server.ts` | **Your machine.** Server-only. The token never reaches a browser. |
| The endpoint both extensions call | `app/routes/api.quicktag.tsx` | **Your machine.** |
| Install-time seed | `hooks.afterAuth` in `app/shopify.server.ts` | **Your machine**, during the OAuth redirect. |
| Action extension (modal) | `extensions/quicktag-action/` | **Shopify's infrastructure.** A sandboxed worker Shopify hosts and executes inside the admin page. |
| Block extension (inline card) | `extensions/quicktag-block/` | **Shopify's infrastructure.** Same sandbox, rendered inline instead of in a modal. |

The consequence: the extensions cannot `import` anything from `app/`. Those two
halves live on different machines.

**They do not talk to the Admin API directly.** Both go through
`/api/quicktag` on this app's own server, which is the only place an archive or
unarchive sequence exists. `fetch("/api/quicktag")` from an extension resolves
against the app's `application_url`, so the tunnel URL — which changes on every
`shopify app dev` — never appears in either bundle, and Shopify attaches an
`Authorization: Bearer <OIDC ID token>` header automatically on requests to the
app's own domain. `authenticate.admin` exchanges that for an Admin API context;
its `cors()` helper puts the headers on the reply that let the sandbox read it.
See `extensions/*/src/quicktag-api.ts`, which is byte-identical in both
extensions and contains no tag logic at all.

`shopify app dev` has to be running for any of it: the CLI compiles the
extension bundles, and the app server is in the request path for every write.

## The admin's own Tags card never repaints. Read this before changing anything.

**Nothing an extension can call makes Shopify's built-in Tags card show a tag
change without a full page reload.** This is the single most important fact about
the app, it cost a long investigation, and every "obvious" fix below has already
been tried and failed.

Measured on a real store with a throwaway probe extension, not inferred from
docs. Inside one action, before a single `shopify.close()`:

| Write | Repaints without a reload? |
| --- | --- |
| Product **title**, via `productUpdate` | **Yes** |
| Draft order **note**, from a draft-order action | **Yes** |
| Tag via `tagsAdd`, direct API from the sandbox | **No** |
| Tag via `productUpdate` — the same mutation that repaints the title | **No** |
| Tag via the app's own backend, server-side, with the app's access token | **No** |

Also ruled out as variables: extension `api_version` (2025-10 behaves exactly
like 2026-07), and launch path (**More actions** vs `shopify.navigation.navigate`
from the block).

Every write landed — a reload always shows the change. So the page *does* refetch
on close, the refetch *does* include the tags, and the admin's Tags card simply
doesn't rerender from it. That is Shopify-side and unreachable from an
extension. Don't spend more time on it.

Note what this is *not*: it isn't "actions can't refresh their page" — the title
and the draft order note prove they can. It is this one card, on this one page.

**This matters more than it looks.** Archiving *removes* tags. A merchant who
archives and sees the native Tags card still listing every one of them has every
reason to think it failed and to try again. So both extensions confirm their own
writes and both say, in the same words, that Shopify's card catches up on the
next refresh.

Worth reporting to Shopify — the title control is the strongest evidence: same
action, same close, one field repaints and the other doesn't. If they fix it,
QuickTag needs no code change.

### So what does each extension actually do

| | `quicktag-action` (modal) | `quicktag-block` (inline card) |
| --- | --- | --- |
| Reached by | **More actions** → **Archive or unarchive tags** | Card on the page, once pinned — same name in the picker |
| Writes | Yes, behind a confirm step | Yes, in place, no dialog |
| Confirms the write | Success banner; the modal stays open | The card rewrites itself into the other state, plus a banner that retires after 5s |
| Repaints Shopify's Tags card | No | No |
| Stays current with edits made elsewhere | Reads fresh on open | **Yes**, polls every 10s |
| Setup by merchant | None | Must pin the block to the product page once |

Neither is the "better" one. The action needs no setup and is the only admin
target that can raise an `s-modal`; the block is live and needs no navigation.
The merchant's confirmation comes from QuickTag's UI either way.

**The block cannot delegate to the action.** It was the first design. A block
can open an action through `shopify.navigation.navigate`, but an action reads
product state when it opens and has no way to be told a write just happened —
no launch parameter, and `storage` is per-extension. Opened after a successful
archive it would read the new state and render its ordinary "Press Archive…"
form, which is the opposite of a confirmation. So the card reports its own
result. `s-modal` is not available to it: the per-target allowlists in
`@shopify/ui-extensions/build/ts/surfaces/admin/targets/` are the record, and
only `admin.app.home.render` imports `components/Modal.d.ts`.

### Why the action doesn't close itself, and has no Reload button

It used to close on success. That was actively misleading: with the Tags card
staying stale, an auto-close dropped the merchant back on a page that looked
completely unchanged — indistinguishable from the button having done nothing.

So the modal stays open, states what changed, and says a refresh is needed.

**One primary button in every state:**

| State | Primary | Secondary |
| --- | --- | --- |
| Active product | **Archive** | the host's own Cancel |
| Archived product | **Unarchive** (critical tone if "keep newer tags" is unchecked) | the host's own Cancel |
| Write in flight | spinning | our own **Cancel**, disabled |
| Done / failed to load | — | **Done** |

The `secondary-actions` slot renders the host's Cancel whenever it is empty, and
the slot cannot be emptied, only occupied. After a write, "Cancel" reads as a way
to undo it, which it is not — hence **Done**. During a write the host's Cancel
stays clickable and would close the modal on a request the server is still
finishing, so it is replaced with a disabled one. Details in the file.

It asks for a refresh rather than offering a Reload control because **a reload
cannot be triggered from an action modal at all.** Four routes were tried on a
real store:

| # | Attempt | Result |
| --- | --- | --- |
| 1 | Script it | Impossible. No `navigation` on this target; `window.location` is the sandbox's own document. |
| 2 | `s-button href="https://admin.shopify.com/store/<handle>/products/<id>" target="_top"` | Navigates, but **opens a new tab** — the host reads an absolute URL as external. |
| 3 | `s-button href="shopify:admin/products/<id>"` | **Nothing.** Hover shows no URL — `s-button` renders no anchor for a protocol it can't resolve. |
| 4 | `s-link href="shopify:admin/products/<id>"` | Resolves (hover shows the real URL) and **does** attempt to navigate. The admin's router then aborts it. |

Route 4 is the informative one. The console error is:

```
A router only supports one blocker at a time
```

That's React Router's `useBlocker`. A product details page registers a
navigation blocker for its unsaved-changes guard, and the open action modal
registers another. Two blockers, the router throws, navigation aborted. Nothing
in an extension can unregister the host page's blocker.

Note from route 3: `s-button` navigates plain URLs but does **not** resolve
Shopify's custom protocols. Only `s-link` does. The same `shopify:admin` URL
works fine from the Archived products table, because there is no competing
blocker on that page.

For completeness, `navigation` does exist — but only on **block** targets, and
its own docs scope it to *"navigating from a block extension to an action
extension on the same resource page."* It cannot navigate the admin either.

### Why the block polls

Edits made anywhere else on the page — the merchant deleting a tag in Shopify's
Tags card and saving, or the action modal archiving the product — are never
pushed to the block. `BlockExtensionApi` is `auth`, `data`, `extension`, `i18n`,
`intents`, `navigation`, `picker`, `query`, `resourcePicker`, `storage` —
checked against both the installed `@shopify/ui-extensions` types and the
published API reference. No product-save event, no host-page change event, no
action-closed event, and `data` is a plain `{selected: {id}[]}` object rather
than a reactive one.

No push doesn't mean no live updates — the card **pulls** instead.
`POLL_INTERVAL_MS = 10_000`: it re-reads state and the shop's archive tags every
10s, so an edit made elsewhere shows up within one tick. Poll failures against a
card that already has good data are swallowed; the next tick will very likely
succeed. `busy` stands the poll down during a write, so a slow read cannot paint
pre-write state over the mutation's fresh reply.

**The interval is unconditional, and cannot be made otherwise.** An earlier
version skipped ticks on a hidden tab and re-read on `visibilitychange`. Neither
did anything: `document` in an extension is remote-dom's polyfill, whose
`Document` declares `body`, `head`, `documentElement`, `createElement`,
`createTextNode`, `createComment`, `createDocumentFragment`, `createEvent`,
`importNode`, `adoptNode` — and no `visibilityState` or `hidden`. The guard
compared `undefined === "hidden"` on every tick and the listener waited for an
event the sandbox cannot receive. Both were removed; behaviour did not change.
A product page in a background tab re-reads every 10s until it is closed.

## Archive and unarchive

Both sequences live in `app/quicktag-archive.server.ts` and nowhere else. The
order of operations is the safety contract, not a style choice.

**Archive:**

1. Validate the requested tags. Read live state; refuse if already archived.
2. Snapshot = the live tags **minus** the tags about to be applied.
3. Write the backup metafield, and confirm it round-tripped.
4. *Only then* apply the archive tags.
5. *Only then* remove the snapshot's tags.

Applied tags go on **before** the removals so the product is never, at any
instant, both untagged and unmarked. If the process dies between 4 and 5 the
product is archived with tags still on it, which unarchive cleans up.

**Unarchive:**

1. Read the backup. `appliedTags` come from it and nowhere else.
2. Add the snapshot back first, so nothing is ever missing mid-sequence.
3. Remove per the checkbox — the applied tags only, or everything not in the
   snapshot.
4. **Re-read from Shopify** and verify every saved tag is present.
5. *Only then* delete the backup.

Step 4 is a fresh read rather than the mutation payload because it gates an
irreversible delete of the only copy of the snapshot. Any failure keeps the
backup, so retrying is always safe.

`keepNewerTags` defaults to the safe branch — only an explicit `false` removes
tags added since archiving, and the UI shows a critical banner before it does.
The choice is only offered when there is something to choose about.

**Casing is load-bearing.** Shopify dedupes tags case-insensitively but stores
the casing added first, so a product carrying `Archive` against a configured
`archive` is the same tag to Shopify and a different string to JavaScript. Every
comparison in that file is case-insensitive, and every string handed to
`tagsRemove` is the exact string Shopify returned — never the merchant's typing.

## Archive tags are reserved

A tag QuickTag applies belongs to QuickTag, **whether or not the product already
carried it.** An archive tag already on the product is excluded from the snapshot
like any other applied tag, and unarchive removes it — so the product comes back
without a tag it was carrying beforehand.

This is a design rule, not a gap. The alternative — recording which applied tags
were pre-existing and sparing those — makes a tag's fate depend on per-product
history the merchant cannot see: two products that look identical in the admin,
both tagged `archive`, would unarchive differently. The reserved rule is the one
a merchant can predict.

It is also **stated to the merchant**, on the settings card beside the field
where the tags are chosen and in the `WhatArchivingDoes` panel. The one-line
version: don't use a tag as both an archive tag and a real product tag.

It sets the count the UI shows, too. What archiving saves is
`tagsNotIn(liveTags, appliedTags)`, so any surface offering to "save and remove N
tags" has to count *that* list. The block card once counted the product's live
tags and overstated N on exactly the products this rule applies to.

## Vocabulary

Two rules are settled, written up in `app/quicktag-copy.tsx`, and worth reading
before touching merchant-facing text:

- **The verb is "archive" and the object is always "tags".** Never "archive this
  product" — that is the phrase Shopify has already defined to mean unpublish.
  Buttons, modal headings, success banners, error headings, server refusals: the
  noun is tags. Names of *sets* are the exception ("Archived products").
- **The pair is archive / unarchive. "Restore" is not a merchant-facing word.**
  The code keeps `restoreProduct` and `intent: "restore"` deliberately: a string
  a merchant reads follows the button, an identifier does not.

The merchant's name for `managedTags` is **archive tags**. The settings field is
labelled that, and every banner that sends them there uses the same words.

## Storage

Three things, all metafields.

**Shop config** — the archive tags:

```
owner     AppInstallation   (this app's install on this one shop)
namespace $app              (the app-reserved namespace — note the `$`)
key       config
type      json
value     {"v":3,"managedTags":["archive"]}
```

`AppInstallation` because this is *app configuration*, not product data.
Metafields owned by the app installation have no merchant-facing UI at all, so
the value can never leak into the merchant's product metafield list. No
definition for this key: definitions exist to give merchants a typed editable
field, and there is no admin surface here to give one to.

Config versions, all still readable: v1.0's bare `tag_value` string, v2's
singular `{"v":2,"managedTag":"…"}`, v3's list. Older shapes are upgraded in
memory on every read and rewritten in the current shape on the next save.

Three layers make sure a write always has something to apply:

1. **Seed** — `afterAuth` writes `["archive"]` at install, idempotently, so it
   never clobbers what the merchant has set. Failures are logged, not thrown.
2. **Settings screen** — the merchant edits it. Max 25 tags, 255 chars each, no
   commas (Shopify splits tag input on commas, so a comma inside one entry would
   record an applied tag matching nothing and unarchive would never find it).
3. **Runtime fallback** — `/api/quicktag` resolves to `DEFAULT_MANAGED_TAGS` if
   the metafield is missing, empty, or unreadable. Safety net for a failed seed.

**Per-product backup** — written on archive, deleted on unarchive:

```
owner     Product
namespace $app
key       tag_backup
type      json
value     {"v":3,"tagState":"archived","updatedAt":"…",
           "savedTags":["Summer"],"appliedTags":["archive"]}
```

Its **presence is the archived flag** — a product with no backup is not
archived, which is unambiguous in a way that a `tagState: "active"` record with
an empty snapshot is not. v2's singular `appliedTag` is still read: a product
archived under v1.1 has had its tags removed already, and that blob is the only
copy.

`appliedTags` are per-product and unarchive reads them from there and nowhere
else. If it derived them from live config instead, a merchant changing the shop
defaults would make every previously-archived product strip the wrong tag on the
way back.

**Sessions** — Prisma, SQLite in dev.

## Archived products

`/app/managed` lists every product QuickTag currently has archived. Read-only:
no tags, no backups, no config.

It is **not** a product query. Admin product search filters on title, tag,
status, vendor, sku, dates — metafields are not among them, with or without a
definition, so a product-first approach means reading the whole catalogue on
every page load. Instead it walks the backup metafields directly:

```graphql
metafieldDefinition(identifier: {ownerType, namespace, key}) {
  metafieldsCount
  metafields(first:, after:) { nodes { value, owner { ...on Product { id title } } } }
}
```

That is exact, hands back each metafield's owning product in the same round
trip, and paginates natively. Its one precondition is a definition on the
namespace/key pair — which is the **only** reason `quicktag-managed.server.ts`
creates one, on first use rather than at install so an existing install picks it
up without re-authing.

Two things measured rather than assumed, both written up in that file's header:

- The created definition comes back as `access: { admin: "MERCHANT_READ" }`,
  not app-private. `MetafieldAccessInput.admin` cannot express PRIVATE — its
  only values are MERCHANT_READ and MERCHANT_READ_WRITE — so any definition on
  this key is at least merchant-readable. Shopify does not render it in the
  product page's Metafields section, and it is accepted on that basis.
- `UNSTRUCTURED_ALREADY_EXISTS` does **not** fire on a shop with pre-existing
  unstructured backups. A definition created over five of them adopted all five.

Rows are ordered by whatever the metafields connection returns — that connection
takes no `sortKey`, so it is not product order and the page does not claim it
is. Sorting isn't offered.

## Access scopes

```toml
scopes = "write_products"
```

That's the whole list. `write_products` covers `tagsAdd`/`tagsRemove` on a
Product and the product metafield.

There is deliberately **no metafield scope**: app-data metafields are owned by
the app, so the app can always read and write its own. Shopify publishes no
`*_app_data_metafields` scope, and `read/write_metafields` would be
over-requesting.

## Running it

```bash
npm install
npm run setup               # creates prisma/dev.sqlite — gitignored, so a fresh clone has none
npm run dev                 # -> shopify app dev
```

The first `shopify app dev` prompts you to pick an organization and create or
link an app; it writes `client_id` into `shopify.app.toml` and creates `.env`.
Then press `p` to open the preview URL and install on your dev store.

To use the action (nothing to pin — actions appear the moment the app is
installed):

1. Open any product in the admin.
2. **More actions** → **Archive or unarchive tags**.
3. Press **Archive**. The modal stays open and confirms it; **Done** dismisses.
   Shopify's Tags card below keeps its page-load value until you refresh the page
   yourself — see the section above, that's a platform limit, not a bug here.

To use the block, pin it first:

1. Open any product in the admin.
2. Top right → **More actions** → **Add app block** (or the page's customise
   control, depending on admin version) → pick **Archive or unarchive tags**.
3. The card renders inline. Press **Archive** and the card rewrites itself into
   the unarchive state — no modal, no reload. Edit tags elsewhere on the page and
   the card catches up within 10s on its own. Shopify's own Tags card still only
   updates on a page load.

Pointing at a different Shopify app: run `shopify app config link` — never
hand-edit `shopify.app.toml`. Adding a store needs no code changes.

**The app only works while `npm run dev` runs.** A permanent install needs real
hosting. Node 20.19+ required — 22.0 to 22.11 will not work.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs `shopify app dev`: local server + tunnel + extension dev bundle |
| `npm run typecheck` | Typechecks the app (extensions are excluded — they have their own tsconfig) |
| `npx tsc --noEmit -p extensions/quicktag-action/tsconfig.json` | Typechecks the action extension |
| `npx tsc --noEmit -p extensions/quicktag-block/tsconfig.json` | Typechecks the block extension |
| `npm run lint` | ESLint |
| `npm run build` | Production build of the React Router app |

All four checks are clean as of the last change. Two traps worth knowing:

- Each extension's `tsconfig.json` sets `"include": ["src"]`. Drop it and
  `allowJs` + `checkJs` pull the CLI's minified bundle in `dist/` into the
  program, producing hundreds of errors out of Preact's mangled internals.
- The lint script passes `--ignore-path .gitignore`, which **replaces**
  `.eslintignore` rather than adding to it. `.eslintignore` in this repo is
  dead; put exclusions in `ignorePatterns` in `.eslintrc.cjs`.
