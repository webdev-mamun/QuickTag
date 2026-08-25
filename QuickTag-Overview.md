# QuickTag — Technical Overview

Shopify app. Archives a product's tags and restores them. 3–4 minute read.


## 1. What it does

- **Archive** — saves a product's tags to a backup, removes them from the product, applies the shop's archive tags instead.
- **Restore** — puts the saved tags back, removes the archive tags, deletes the backup.
- The product stays published. Only tags change. Effect: it drops out of automated collections and tag filters, reversibly.
- **Archive tags are reserved.** A tag QuickTag applies belongs to QuickTag, even if the product already carried it — it is excluded from the snapshot and removed on restore. So a tag used as both an archive tag and a real product tag gets stripped from products that had it. Design rule, not a bug; stated to the merchant on the settings card and in the `WhatArchivingDoes` panel. See the header of `app/quicktag-archive.server.ts` before changing it.
- **Vocabulary:** the code says `restore` (`restoreProduct`, `intent: "restore"`); every merchant-facing string says **unarchive**. Deliberate, and the rule is written up in `app/quicktag-copy.tsx`.

## 2. The three parts

| Part | Runs where | Location |
|---|---|---|
| Embedded app | Node server + admin iframe | app/routes/ |
| Action extension (popup) | Shopify's sandbox, in the admin | extensions/quicktag-action/ |
| Block extension (card) | Shopify's sandbox, in the admin | extensions/quicktag-block/ |

- **Neither extension decides anything.** Both POST to `/api/quicktag`; all logic is server-side, so the two entry points cannot diverge.
- Action extension = the modal, reached from **More actions**. Available on install.
- Block extension = inline status card. Archives and unarchives **in place**, no dialog; the card rewriting itself into the other state is the confirmation. Must be pinned by the merchant. Polls every 10s.

## 3. How archive and restore work

Both sequences live in **app/quicktag-archive.server.ts**.


### archiveProduct()

| # | Step | Function |
|---|---|---|
| 1 | Validate requested tags | validateTags |
| 2 | Read live tags + status | readProductTagState |
| 3 | Refuse if already archived | archiveProduct |
| 4 | Snapshot = live tags minus marker tags | tagsNotIn |
| 5 | Write backup, confirm it round-tripped | writeBackup |
| 6 | Add marker tags | mutateTags (tagsAdd) |
| 7 | Remove saved tags | mutateTags (tagsRemove) |

- Marker tags go on **before** saved tags come off — the product is never both untagged and unmarked.

### restoreProduct()

| # | Step | Function |
|---|---|---|
| 1 | Read live tags + backup | readProductTagState |
| 2 | Refuse if not archived | restoreProduct |
| 3 | Add saved tags back | mutateTags (tagsAdd) |
| 4 | Remove marker tags (or all others, per checkbox) | mutateTags (tagsRemove) |
| 5 | Fresh re-read, verify every saved tag is present | readProductTagState |
| 6 | Delete backup | deleteBackup |

- Step 5 gates step 6, which is an irreversible delete of the only copy. A failed restore keeps the backup — retry is always safe.

## 4. File map

48 functions, 13 files. Entry points in bold.

| File | Holds | Key functions |
|---|---|---|
| app/quicktag-archive.server.ts | Archive + restore core (14 fns) | **archiveProduct**, **restoreProduct**, readProductTagState, writeBackup, deleteBackup, mutateTags |
| app/quicktag.server.ts | Shop config + tag validation (6) | readQuickTagConfig, writeManagedTags, validateTags, seedQuickTagConfig |
| app/quicktag-managed.server.ts | Archived-products list (5) | **listManagedProducts**, createBackupDefinition |
| app/routes/api.quicktag.tsx | The shared endpoint both extensions call (4) | **loader** (read), **action** (archive/restore) |
| app/routes/app._index.tsx | Settings screen (4) | Settings, loader, action |
| app/routes/app.managed.tsx | Archived products screen (3) | ManagedProducts, loader |
| app/routes/app.tsx | Shell, nav, auth (3) | App, loader, ErrorBoundary |
| app/quicktag-copy.tsx | Shared merchant copy (1) | WhatArchivingDoes |
| app/shopify.server.ts | Shopify SDK setup, install hook | afterAuth → seedQuickTagConfig |
| extensions/quicktag-action/src/ActionExtension.tsx | The modal (5) | Extension |
| extensions/quicktag-block/src/BlockExtension.tsx | The status card (4) | Extension |
| extensions/*/src/quicktag-api.ts | HTTP transport to the app (4) | loadQuickTagState, submitQuickTag |
| app/routes/webhooks.app.*.tsx | Uninstall, scope changes (2) | action |

- `quicktag-api.ts` is **byte-identical in both extensions**. Shopify compiles each extension into its own bundle, so they cannot share code. Keep the copies in step.

## 5. Data storage

| Data | Location | Scope |
|---|---|---|
| Archive tags (`managedTags`) | Metafield `$app.config` on the app installation | Shop |
| Backup (savedTags + appliedTags) | Metafield `$app.tag_backup` on the product | Per archived product |
| Sessions | Prisma (SQLite in dev) | Per shop |

- Both metafields use the app-reserved `$app` namespace — invisible to the merchant metafield UI.
- Restore reads the **product's own** backup, so changing shop defaults can never strip the wrong tags off a product archived earlier.

## 6. Shopify APIs

| Item | Value |
|---|---|
| Admin GraphQL API | 2026-07 |
| UI Extensions API | 2026-07 |
| Scope | write_products (only) |
| Distribution | SingleMerchant — custom/unlisted, not App Store |

| GraphQL operation | Used for |
|---|---|
| tagsAdd / tagsRemove | All tag changes |
| metafieldsSet / metafieldsDelete | Config and per-product backups |
| metafieldDefinitionCreate | One-time setup so backups are queryable |
| product | Reading a product's tags, title and backup |

- Extension targets: `admin.product-details.action.render` and `admin.product-details.block.render`.
- Versions: @shopify/shopify-app-react-router 1.1.0 · app-bridge-react 4.2.4 · ui-extensions 2026.7.0 · React Router 7.12.0 · React 18.3.1 · Prisma 6.16.3.
- **Known platform limit:** Shopify's own Tags card on the product page does not repaint after a write until the page reloads. Confirmed by measurement; unreachable from an extension.

## 7. Install on a new store from local

- **1.** `npm install`
- **2.** `npm run setup` — creates the local DB. `prisma/dev.sqlite` is gitignored, so a fresh clone has none.
- **3.** `npm run dev` — CLI prompts for org, app, then store domain.
- **4.** Press **p**, then **Install app** in the browser.
- **5.** Action extension appears under More actions immediately. Block extension must be pinned by hand.
- **No code changes are needed to add a store.** Only when pointing at a different Shopify app: run `shopify app config link` — never hand-edit `shopify.app.toml`.
- **The app only works while `npm run dev` runs.** A permanent install needs real hosting.
- Node 20.19+ required — 22.0 to 22.11 will not work.
