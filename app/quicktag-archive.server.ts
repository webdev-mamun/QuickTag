/**
 * QuickTag — archive / restore orchestration.
 *
 * WHERE THIS RUNS: your local Node server. Both extensions reach it through
 * app/routes/api.quicktag.tsx; neither of them can `import` this file, because
 * extension bundles execute on Shopify's infrastructure, not yours. This module
 * is the ONLY place the archive and restore sequences exist — that is the point
 * of it. See the route for how the extensions call in.
 *
 * WHAT IT STORES: one app-data metafield per product.
 *   owner     = Product
 *   namespace = "$app"        (app-reserved: invisible to the merchant's
 *                              metafield UI, readable only by QuickTag)
 *   key       = "tag_backup"
 *   type      = json
 *
 * SCHEMA v3:
 *   {
 *     "v": 3,
 *     "tagState": "archived",
 *     "updatedAt": "<ISO 8601>",
 *     "savedTags": ["Summer", "Sale"],
 *     "appliedTags": ["Sold out", "archive"]
 *   }
 *
 * The metafield's PRESENCE is the archived flag. A restored product has no
 * metafield at all, which is unambiguous in a way that a `tagState: "active"`
 * record with an empty snapshot is not.
 *
 * WHY `appliedTags` IS PER-PRODUCT AND `managedTags` IS NOT. `managedTags` (in
 * quicktag.server.ts) are the shop-wide defaults the Archive modal pre-fills.
 * `appliedTags` are the tags that actually went onto THIS product. Restore
 * reads `appliedTags` and nothing else: if it derived them from live config
 * instead, a merchant changing the defaults from "archive" to "Sold out" would
 * make every previously archived product strip the wrong tag on restore and
 * leave "archive" behind forever.
 *
 * WHY `savedTags` EXCLUDES `appliedTags`. The snapshot is what the product
 * looked like BEFORE QuickTag touched it. Leaving an applied tag in the
 * snapshot would make Restore put it back immediately after removing it.
 *
 * ARCHIVE TAGS ARE RESERVED. This is the rule, not a gap in it: a tag QuickTag
 * applies belongs to QuickTag, whether or not the product already carried it.
 * An archive tag the product already had is excluded from the snapshot like any
 * other applied tag, and restore removes it — so the product comes back without
 * a tag it was carrying before QuickTag touched it.
 *
 * DON'T "FIX" THIS. Recording which applied tags were pre-existing, and sparing
 * those on restore, is the obvious change and it is the wrong one. It makes a
 * tag's fate depend on per-product history the merchant cannot see: two
 * products that look identical in the admin, both tagged `archive`, would
 * unarchive differently depending on which one QuickTag added the tag to. The
 * reserved rule is the one a merchant can predict without reading this file.
 *
 * THE COST IS STATED, NOT HIDDEN, which is what makes it a rule rather than a
 * silent trap. Two surfaces carry it — the settings card, beside the field where
 * the tags are chosen, and the WhatArchivingDoes panel. See app/quicktag-copy.tsx
 * for both, and for why they are worded differently. The limitation in one line:
 * don't use a tag as both an archive tag and a real product tag.
 *
 * IT ALSO SETS THE COUNT THE UI SHOWS. What archiving saves is
 * `tagsNotIn(liveTags, appliedTags)`, so any surface that offers to "save and
 * remove N tags" has to count that list and not the product's live tags. The
 * block extension counted the live tags and overstated N on exactly the
 * products this rule applies to.
 *
 * CASE HANDLING, WHICH IS LOAD-BEARING. Shopify dedupes tags
 * case-insensitively but stores the casing that was added FIRST. A product
 * carrying "Archive" against a configured "archive" is the same tag to Shopify
 * and a different string to JavaScript. So: every comparison here is
 * case-insensitive, and every string handed to `tagsRemove` is the EXACT
 * string Shopify returned, never the one the merchant typed.
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { METAFIELD_NAMESPACE, validateTags } from "./quicktag.server";

/** Product-level backup key. Distinct from the AppInstallation "config" key. */
export const BACKUP_KEY = "tag_backup";
export const BACKUP_VERSION = 3;

/**
 * BACKUP VERSIONS:
 *   v2  {"v":2, ..., "appliedTag": "archive"}    one tag, singular key
 *   v3  {"v":3, ..., "appliedTags": ["archive"]} a list
 *
 * v2 is still READ — see parseBackup — because a product archived under v1.1
 * has its tags stripped and its only route home is this blob. Dropping the
 * reader would strand it. v2 is never WRITTEN again; the next action on such a
 * product rewrites it as v3.
 */
export interface TagBackupV3 {
  v: typeof BACKUP_VERSION;
  tagState: "archived";
  updatedAt: string;
  savedTags: string[];
  /**
   * Every tag QuickTag applied when archiving this product. Restore removes
   * exactly these and derives them from nowhere else — see the file header.
   */
  appliedTags: string[];
}

/** What every entry point in this module resolves to, success or failure. */
export interface ProductTagState {
  productId: string;
  title: string;
  /** The product's tags right now, in Shopify's own casing. */
  tags: string[];
  tagState: "active" | "archived";
  /** Empty unless archived. Kept readable while archived, by design. */
  savedTags: string[];
  /** Empty unless archived. */
  appliedTags: string[];
  updatedAt: string | null;
  /**
   * Tags added since archiving — live tags that are in neither the snapshot nor
   * the applied list. Non-empty is exactly the condition for showing the
   * Restore checkbox: with nothing newer, both restore paths do the same thing
   * and the choice would be noise.
   */
  newerTags: string[];
}

/*
 * A NOTE ON THESE MESSAGES. Every `error` string in this file renders verbatim
 * in a merchant-facing banner — both extensions pass `response.error` straight
 * through — so they are merchant copy that happens to live in a server module.
 *
 * THEY DO NOT SAY "BACKUP". Five of them used to. The merchant has never been
 * told QuickTag keeps one: it is an app-data metafield with no admin surface,
 * introduced nowhere in the UI, and naming it in an error hands them a second
 * thing to worry about on top of the failure they already have. The archived-
 * products page dropped its own internal noun ("index") for exactly this reason
 * — see listManagedProducts in quicktag-managed.server.ts.
 *
 * WHAT SURVIVED THE REWORDING is the part that does the work: whether their
 * tags are safe, and what to press next. "The backup was kept — try again"
 * became "Your saved tags are still safe — try again". Same promise, no new
 * vocabulary. If a message ever loses that reassurance to save a word, the
 * rewording went too far.
 */
export type QuickTagErrorCode =
  | "no_product"
  | "invalid_tag"
  | "already_archived"
  | "not_archived"
  | "backup_write_failed"
  | "tag_write_failed"
  | "verify_failed"
  | "backup_clear_failed";

export type QuickTagResult =
  | { ok: true; state: ProductTagState }
  | {
      ok: false;
      code: QuickTagErrorCode;
      error: string;
      /** Present whenever the product could be read — the UI still repaints. */
      state?: ProductTagState;
    };

const READ_STATE_QUERY = `#graphql
  query QuickTagProductState($id: ID!, $namespace: String!, $key: String!) {
    product(id: $id) {
      id
      title
      tags
      backup: metafield(namespace: $namespace, key: $key) {
        value
      }
    }
  }
`;

const WRITE_BACKUP_MUTATION = `#graphql
  mutation QuickTagWriteBackup($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DELETE_BACKUP_MUTATION = `#graphql
  mutation QuickTagDeleteBackup($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * `node { ... on Product { tags } }` on both tag mutations is what keeps the
 * sequences honest: each step hands back the product's full tag list as it
 * stands after the write, so the next step decides on server truth rather than
 * on a locally predicted list.
 */
const TAGS_ADD_MUTATION = `#graphql
  mutation QuickTagTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
        ... on Product {
          tags
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `#graphql
  mutation QuickTagTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
        ... on Product {
          tags
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/* ------------------------------------------------------------------ *
 * Tag helpers. Every one of these is case-insensitive on purpose —
 * see the file header.
 * ------------------------------------------------------------------ */

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function hasTag(tags: string[], tag: string): boolean {
  return findLiveTag(tags, tag) !== undefined;
}

/**
 * Returns the product's OWN spelling of a tag, which is the only string safe to
 * pass to `tagsRemove`. Returns undefined when the product doesn't carry it.
 */
export function findLiveTag(tags: string[], tag: string): string | undefined {
  const needle = normalizeTag(tag);
  return tags.find((current) => normalizeTag(current) === needle);
}

/**
 * Maps requested tags onto the product's OWN spellings, dropping any the
 * product doesn't carry. The result is the only list safe to hand `tagsRemove`.
 */
function toLiveTags(liveTags: string[], wanted: string[]): string[] {
  return wanted
    .map((tag) => findLiveTag(liveTags, tag))
    .filter((tag): tag is string => tag !== undefined);
}

/** Tags in `tags` that have no case-insensitive match in `other`. */
function tagsNotIn(tags: string[], other: string[]): string[] {
  const known = new Set(other.map(normalizeTag));
  return tags.filter((current) => !known.has(normalizeTag(current)));
}

/* ------------------------------------------------------------------ *
 * Metafield read / write
 * ------------------------------------------------------------------ */

/** Drops non-strings and blanks from an unknown array-ish value. */
function toTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (tag): tag is string => typeof tag === "string" && tag.trim() !== "",
  );
}

/**
 * Narrows an unknown JSON value to a backup, upgrading v2 in memory.
 *
 * ANY OTHER VERSION READS AS "no backup". v1.0 never wrote a product metafield
 * — it only ever appended a tag — so there is no v1 shape to map from. The
 * version guard keeps a future v4 from being silently misread as v3 by an older
 * deploy still running somewhere.
 *
 * THE v2 BRANCH IS NOT OPTIONAL. A product archived under v1.1 has had its tags
 * removed from Shopify already; this blob is the only copy. Reading it as "not
 * archived" would show the merchant an un-archived product with no tags and no
 * way back.
 */
export function parseBackup(
  raw: string | null | undefined,
): TagBackupV3 | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as
      (Partial<TagBackupV3> & { appliedTag?: unknown }) | null;
    if (!parsed || parsed.tagState !== "archived") return null;

    const updatedAt =
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date(0).toISOString();
    const savedTags = toTagList(parsed.savedTags);

    // v3: the current shape.
    if (parsed.v === BACKUP_VERSION) {
      const appliedTags = toTagList(parsed.appliedTags);
      if (!appliedTags.length) return null;

      return {
        v: BACKUP_VERSION,
        tagState: "archived",
        updatedAt,
        savedTags,
        appliedTags,
      };
    }

    // v2: one tag under a singular key. Read as a list of one.
    if (parsed.v === 2 && typeof parsed.appliedTag === "string") {
      const appliedTag = parsed.appliedTag.trim();
      if (!appliedTag) return null;

      return {
        v: BACKUP_VERSION,
        tagState: "archived",
        updatedAt,
        savedTags,
        appliedTags: [appliedTag],
      };
    }

    return null;
  } catch {
    // Corrupt JSON reads as "not archived". The alternative — throwing — would
    // brick the product page card with no way for the merchant to clear it.
    return null;
  }
}

function toState(
  product: { id: string; title: string; tags: string[] },
  backup: TagBackupV3 | null,
): ProductTagState {
  if (!backup) {
    return {
      productId: product.id,
      title: product.title,
      tags: product.tags,
      tagState: "active",
      savedTags: [],
      appliedTags: [],
      updatedAt: null,
      newerTags: [],
    };
  }

  return {
    productId: product.id,
    title: product.title,
    tags: product.tags,
    tagState: "archived",
    savedTags: backup.savedTags,
    appliedTags: backup.appliedTags,
    updatedAt: backup.updatedAt,
    newerTags: tagsNotIn(product.tags, [
      ...backup.savedTags,
      ...backup.appliedTags,
    ]),
  };
}

/** Reads a product's tags and backup in one round trip. */
export async function readProductTagState(
  admin: AdminApiContext,
  productId: string,
): Promise<ProductTagState | null> {
  const response = await admin.graphql(READ_STATE_QUERY, {
    variables: {
      id: productId,
      namespace: METAFIELD_NAMESPACE,
      key: BACKUP_KEY,
    },
  });
  const body = (await response.json()) as {
    data?: {
      product?: {
        id: string;
        title: string;
        tags: string[];
        backup: { value: string } | null;
      } | null;
    };
  };

  const product = body.data?.product;
  if (!product) return null;

  return toState(product, parseBackup(product.backup?.value));
}

/**
 * Writes the backup and CONFIRMS it landed.
 *
 * The confirmation is not defensive programming for its own sake: the very next
 * thing the archive sequence does is remove the merchant's tags, and the
 * backup is the only copy of them. `metafieldsSet` can fail three ways —
 * transport `errors`, payload `userErrors`, or an empty success — and a
 * "probably saved" backup followed by a successful `tagsRemove` is data loss.
 *
 * Returns a user-facing message on failure, null on success.
 */
async function writeBackup(
  admin: AdminApiContext,
  productId: string,
  backup: TagBackupV3,
): Promise<string | null> {
  const response = await admin.graphql(WRITE_BACKUP_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: productId,
          namespace: METAFIELD_NAMESPACE,
          key: BACKUP_KEY,
          type: "json",
          value: JSON.stringify(backup),
        },
      ],
    },
  });
  const body = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        metafields: { key: string; value: string }[] | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    return body.errors.map((error) => error.message).join(" ");
  }

  const userErrors = body.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    return userErrors.map((error) => error.message).join(" ");
  }

  // Read the value back out of the mutation's own payload and compare it to
  // what we sent. Anything short of an exact round trip is a failed backup.
  const written = parseBackup(
    body.data?.metafieldsSet?.metafields?.find(
      (metafield) => metafield.key === BACKUP_KEY,
    )?.value,
  );

  const sameList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((tag, index) => tag === b[index]);

  const roundTripped =
    written !== null &&
    sameList(written.appliedTags, backup.appliedTags) &&
    sameList(written.savedTags, backup.savedTags);

  if (!roundTripped) {
    return "Shopify didn't confirm your tags were saved, so none were changed.";
  }

  return null;
}

/** Deletes the backup. Returns a user-facing message on failure, null on success. */
async function deleteBackup(
  admin: AdminApiContext,
  productId: string,
): Promise<string | null> {
  const response = await admin.graphql(DELETE_BACKUP_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: productId,
          namespace: METAFIELD_NAMESPACE,
          key: BACKUP_KEY,
        },
      ],
    },
  });
  const body = (await response.json()) as {
    data?: {
      metafieldsDelete?: {
        deletedMetafields: ({ key: string } | null)[] | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    return body.errors.map((error) => error.message).join(" ");
  }

  const userErrors = body.data?.metafieldsDelete?.userErrors ?? [];
  if (userErrors.length) {
    return userErrors.map((error) => error.message).join(" ");
  }

  return null;
}

/**
 * Runs one tag mutation and returns the product's tag list as it stands after
 * the write. Throws on any failure — both callers treat a failed tag write as
 * fatal to their sequence.
 */
async function mutateTags(
  admin: AdminApiContext,
  mutation: string,
  operation: "tagsAdd" | "tagsRemove",
  productId: string,
  tags: string[],
): Promise<string[] | null> {
  const response = await admin.graphql(mutation, {
    variables: { id: productId, tags },
  });
  const body = (await response.json()) as {
    data?: Record<
      string,
      {
        node: { id: string; tags?: string[] } | null;
        userErrors: { field: string[] | null; message: string }[];
      } | null
    >;
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join(" "));
  }

  const payload = body.data?.[operation];
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error) => error.message).join(" "));
  }
  if (!payload?.node) {
    throw new Error("Shopify did not confirm the tag change.");
  }

  // Null-guarded so a response-shape change degrades to "re-read next time"
  // rather than a crash. Callers fall back to their own last known list.
  return payload.node.tags ?? null;
}

/* ------------------------------------------------------------------ *
 * The two sequences
 * ------------------------------------------------------------------ */

/**
 * ARCHIVE. Order of operations is the safety contract:
 *
 *   1. Read live state. Refuse if already archived.
 *   2. Snapshot the live tags MINUS the tags about to be applied.
 *   3. Write the backup, and confirm it round-tripped.
 *   4. Only then apply `appliedTags`.
 *   5. Only then remove the snapshot's tags.
 *
 * `appliedTags` go on BEFORE the removals so the product is never, at any
 * instant, both untagged and unmarked. If the process dies between 4 and 5 the
 * product is archived with some tags still on it, which Restore cleans up.
 *
 * Every removal uses Shopify's own spelling of the tag, taken from the read in
 * step 1 — never the merchant's typed casing.
 */
export async function archiveProduct(
  admin: AdminApiContext,
  options: { productId: string; appliedTags: string[] },
): Promise<QuickTagResult> {
  const validated = validateTags(options.appliedTags);
  if ("error" in validated) {
    return { ok: false, code: "invalid_tag", error: validated.error };
  }
  const appliedTags = validated.tags;

  const state = await readProductTagState(admin, options.productId);
  if (!state) {
    return {
      ok: false,
      code: "no_product",
      error: "That product could not be read. Refresh the page and try again.",
    };
  }

  // Re-checked server-side rather than trusting a disabled button: the block
  // extension polls on a 10s interval, so its idea of "active" can be stale by
  // the time a click lands, and the two extensions can act on the same product
  // at the same time.
  if (state.tagState === "archived") {
    return {
      ok: false,
      code: "already_archived",
      error: "This product's tags are already archived.",
      state,
    };
  }

  // The snapshot is everything EXCEPT the marks about to be applied. Leaving an
  // applied tag in it would make Restore put the mark straight back after
  // removing it.
  const savedTags = tagsNotIn(state.tags, appliedTags);

  const backup: TagBackupV3 = {
    v: BACKUP_VERSION,
    tagState: "archived",
    updatedAt: new Date().toISOString(),
    savedTags,
    appliedTags,
  };

  const backupError = await writeBackup(admin, options.productId, backup);
  if (backupError) {
    return {
      ok: false,
      code: "backup_write_failed",
      error: backupError,
      state,
    };
  }

  let liveTags = state.tags;

  try {
    // Only the marks the product doesn't already carry. Adding one it has
    // would be a no-op — Shopify keeps its existing casing regardless — and
    // sending an empty list is an error, so an all-present list skips the
    // mutation entirely.
    const toAdd = tagsNotIn(appliedTags, liveTags);
    if (toAdd.length) {
      liveTags = (await mutateTags(
        admin,
        TAGS_ADD_MUTATION,
        "tagsAdd",
        options.productId,
        toAdd,
      )) ?? [...liveTags, ...toAdd];
    }

    if (savedTags.length) {
      liveTags =
        (await mutateTags(
          admin,
          TAGS_REMOVE_MUTATION,
          "tagsRemove",
          options.productId,
          savedTags,
        )) ?? tagsNotIn(liveTags, savedTags);
    }
  } catch (caught) {
    // The backup is already written and confirmed, so the product reads as
    // archived and Restore can clean up whatever is left on it. Say so, rather
    // than implying nothing happened.
    const fresh = await readProductTagState(admin, options.productId);
    return {
      ok: false,
      code: "tag_write_failed",
      error: `${
        caught instanceof Error
          ? caught.message
          : "The tags could not be changed."
      } Your tags were saved first, so Unarchive will put them back.`,
      state: fresh ?? state,
    };
  }

  return {
    ok: true,
    state: toState(
      { id: state.productId, title: state.title, tags: liveTags },
      backup,
    ),
  };
}

/**
 * RESTORE. `keepNewerTags` is the checkbox, and it is checked by default:
 *
 *   true  — put the snapshot back, KEEP anything added since, remove only
 *           `appliedTags`.
 *   false — put the snapshot back and remove EVERYTHING else, `appliedTags`
 *           included. Destructive: it also drops tags added by the merchant
 *           by hand and by other apps. The caller is responsible for warning.
 *
 * Order of operations is the safety contract:
 *
 *   1. Read the backup. `appliedTags` come from it and nowhere else.
 *   2. Add the snapshot back first, so nothing is ever missing mid-sequence.
 *   3. Remove per the checkbox.
 *   4. RE-READ from Shopify and verify every saved tag is present.
 *   5. Only then delete the backup.
 *
 * Step 4 is a fresh read rather than the mutation payload because it gates an
 * irreversible delete of the only copy of the snapshot. Tags kept by the
 * checkbox are irrelevant to it — the check is that the snapshot is fully back,
 * not that nothing else exists.
 */
export async function restoreProduct(
  admin: AdminApiContext,
  options: { productId: string; keepNewerTags: boolean },
): Promise<QuickTagResult> {
  const state = await readProductTagState(admin, options.productId);
  if (!state) {
    return {
      ok: false,
      code: "no_product",
      error: "That product could not be read. Refresh the page and try again.",
    };
  }

  if (state.tagState !== "archived" || !state.appliedTags.length) {
    return {
      ok: false,
      code: "not_archived",
      error:
        "This product's tags aren't archived, so there's nothing to unarchive.",
      state,
    };
  }

  const { savedTags, appliedTags } = state;
  let liveTags = state.tags;

  try {
    if (savedTags.length) {
      liveTags = (await mutateTags(
        admin,
        TAGS_ADD_MUTATION,
        "tagsAdd",
        options.productId,
        savedTags,
      )) ?? [...liveTags, ...tagsNotIn(savedTags, liveTags)];
    }

    // Resolved against the post-add list so every string handed to tagsRemove
    // is Shopify's own spelling.
    //
    // `tagsNotIn(appliedTags, savedTags)` is a guard that should never fire:
    // the snapshot is captured with the applied tags excluded. But if a corrupt
    // backup ever put one back into savedTags, removing it here would undo the
    // restore performed one line above.
    const removals = options.keepNewerTags
      ? toLiveTags(liveTags, tagsNotIn(appliedTags, savedTags))
      : tagsNotIn(liveTags, savedTags);

    if (removals.length) {
      liveTags =
        (await mutateTags(
          admin,
          TAGS_REMOVE_MUTATION,
          "tagsRemove",
          options.productId,
          removals,
        )) ?? tagsNotIn(liveTags, removals);
    }
  } catch (caught) {
    const fresh = await readProductTagState(admin, options.productId);
    return {
      ok: false,
      code: "tag_write_failed",
      error: `${
        caught instanceof Error
          ? caught.message
          : "The tags could not be changed."
      } Your saved tags are still safe — try unarchiving again.`,
      state: fresh ?? state,
    };
  }

  // Fresh read, not the mutation payload. This is the gate on deleting the
  // backup, so it is worth one extra round trip.
  const verified = await readProductTagState(admin, options.productId);
  const missing = verified
    ? tagsNotIn(savedTags, verified.tags)
    : savedTags.slice();

  if (missing.length) {
    return {
      ok: false,
      code: "verify_failed",
      error: `${missing.length} saved tag${
        missing.length === 1 ? "" : "s"
      } could not be put back (${missing.join(", ")}). Your saved tags are still safe — try again.`,
      state: verified ?? state,
    };
  }

  const clearError = await deleteBackup(admin, options.productId);
  if (clearError) {
    return {
      ok: false,
      code: "backup_clear_failed",
      error: `Your tags are back, but this product still counts as archived: ${clearError} Unarchive it again to clear that.`,
      state: verified ?? state,
    };
  }

  return {
    ok: true,
    state: toState(
      {
        id: state.productId,
        title: state.title,
        tags: verified?.tags ?? liveTags,
      },
      null,
    ),
  };
}
