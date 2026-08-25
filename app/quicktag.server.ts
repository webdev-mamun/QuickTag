/**
 * QuickTag — app configuration (AppInstallation metafield).
 *
 * WHERE THIS RUNS: your local Node server (the one `shopify app dev` boots and
 * tunnels to Shopify). Everything in a `*.server.ts` file is stripped out of
 * the browser bundle, so the app's access token never reaches the client.
 *
 * WHAT IT STORES: a single "app-data metafield".
 *   owner     = AppInstallation (this app's install on this one shop)
 *   namespace = "$app"          (the app-reserved namespace)
 *   key       = "config"
 *   type      = json
 *
 * WHY AppInstallation and not a Product metafield: app-data metafields are
 * invisible to the merchant's metafield UI and are readable only by the app
 * that owns them. This value is *app configuration*, not product data, so it
 * must never show up in the merchant's product metafield list. Per-product
 * state lives in app/quicktag-archive.server.ts instead.
 *
 * WHY no metafield *definition* for THIS key: definitions exist to give
 * merchants a typed, editable field in the admin. AppInstallation metafields
 * have no admin surface, so a definition would buy nothing. The `type` we pass
 * to `metafieldsSet` is enough. (The product backup key does have one, for a
 * reason that does not apply here — see quicktag-managed.server.ts.)
 *
 * CONFIG VERSIONS, oldest first:
 *   v1.0  key "tag_value", a bare single_line_text_field holding one tag.
 *   v2    key "config", {"v":2,"managedTag":"archive"}.
 *   v3    key "config", {"v":3,"managedTags":["archive","sold-out"]}.
 *
 * WHY managedTags IS A LIST. A shop archiving for two reasons at once — say
 * `archive` for its own workflow and `sold-out` for a storefront filter — had
 * to pick one. Both are now applied in a single archive, and the merchant edits
 * them as chips rather than as a string they might put a comma in.
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/** Reserved app-owned namespace. NOT "app" — the `$` prefix is what makes it app-reserved. */
export const METAFIELD_NAMESPACE = "$app";

/** Config key. Holds a `QuickTagConfig` JSON blob. */
export const CONFIG_KEY = "config";
export const CONFIG_VERSION = 3;

/**
 * v1.0 config key: the managed tag as a bare string.
 *
 * Read as a last-resort fallback so an install that predates v1.1 keeps
 * whatever the merchant had customised; never written again. Deliberately NOT
 * deleted after migration — deleting it buys nothing, and a failed delete would
 * be a new way for the upgrade to fail on a shop that was otherwise fine.
 */
export const LEGACY_TAG_KEY = "tag_value";

/** Used both to seed on install and as the fallback when nothing is stored. */
export const DEFAULT_MANAGED_TAGS = ["archive"];

/**
 * Shopify's own limit. A longer tag is rejected by the API, so catching it here
 * turns a mutation userError into a form error the merchant can act on.
 */
export const TAG_MAX_LENGTH = 255;

/**
 * Cap on how many tags one archive may apply.
 *
 * Not a Shopify limit — a sanity limit. Products cap at 250 tags total, and a
 * merchant who has queued up 25 archive marks has almost certainly made a
 * mistake that is cheaper to catch here than to unpick from a product later.
 */
export const MAX_MANAGED_TAGS = 25;

export interface QuickTagConfig {
  v: typeof CONFIG_VERSION;
  /** The app-level DEFAULTS. Per-product overrides never write back to these. */
  managedTags: string[];
}

const READ_CONFIG_QUERY = `#graphql
  query QuickTagReadConfig($namespace: String!, $configKey: String!, $legacyKey: String!) {
    currentAppInstallation {
      id
      config: metafield(namespace: $namespace, key: $configKey) {
        value
      }
      legacy: metafield(namespace: $namespace, key: $legacyKey) {
        value
      }
    }
  }
`;

const WRITE_CONFIG_MUTATION = `#graphql
  mutation QuickTagWriteConfig($metafields: [MetafieldsSetInput!]!) {
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

interface ReadConfigResult {
  appInstallationId: string;
  /** null when nothing has ever been stored, under any key or version. */
  managedTags: string[] | null;
  /** True when the stored value predates v3 and should be rewritten on next save. */
  needsUpgrade: boolean;
}

/**
 * Validates ONE tag — one chip in the editor, not a list.
 *
 * THE COMMA RULE IS NOT COSMETIC, and it survives the move to multiple tags.
 * Shopify splits tag input on commas, so "Sold out, clearance" becomes TWO
 * tags. QuickTag would then record one applied tag matching neither, and
 * Restore — which looks each applied tag up in the product's live tags — would
 * find nothing and leave both halves behind permanently. Multiple tags are now
 * expressed as multiple entries, which is exactly why a comma inside one entry
 * is still wrong.
 */
export function validateTag(value: string): { tag: string } | { error: string } {
  const tag = value.trim();

  if (!tag) {
    return { error: "Enter a tag." };
  }
  if (tag.includes(",")) {
    return {
      error:
        "Tags can't contain commas — add them one at a time instead.",
    };
  }
  if (tag.length > TAG_MAX_LENGTH) {
    return { error: `Tags can be at most ${TAG_MAX_LENGTH} characters.` };
  }
  return { tag };
}

/**
 * Validates a whole list, and normalises it.
 *
 * Deduping is case-INSENSITIVE and keeps the first spelling, because that is
 * what Shopify itself does: adding "Archive" to a product carrying "archive" is
 * a no-op that leaves the original casing in place. A list containing both
 * would promise the merchant two tags and deliver one.
 */
export function validateTags(
  values: string[],
): { tags: string[] } | { error: string } {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const validated = validateTag(value);
    if ("error" in validated) return validated;

    const key = validated.tag.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push(validated.tag);
  }

  if (!tags.length) {
    return { error: "Add at least one tag." };
  }
  if (tags.length > MAX_MANAGED_TAGS) {
    return { error: `Use at most ${MAX_MANAGED_TAGS} tags.` };
  }
  return { tags };
}

/**
 * Narrows an unknown JSON value to a config blob, upgrading older shapes in
 * memory. Anything unrecognised reads as absent, which sends the caller to the
 * legacy key and then to the documented default.
 */
function parseConfig(raw: string | null | undefined): QuickTagConfig | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as
      | (Partial<QuickTagConfig> & { managedTag?: unknown })
      | null;
    if (!parsed) return null;

    // v3: the current shape.
    if (parsed.v === CONFIG_VERSION) {
      const managedTags = Array.isArray(parsed.managedTags)
        ? parsed.managedTags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];
      return managedTags.length ? { v: CONFIG_VERSION, managedTags } : null;
    }

    // v2: one tag under a singular key. Read as a list of one.
    if (parsed.v === 2 && typeof parsed.managedTag === "string") {
      const managedTag = parsed.managedTag.trim();
      return managedTag ? { v: CONFIG_VERSION, managedTags: [managedTag] } : null;
    }

    return null;
  } catch {
    // Corrupt JSON reads as "not configured" rather than throwing: the caller
    // falls back to DEFAULT_MANAGED_TAGS, which is strictly better than a 500
    // on a product page.
    return null;
  }
}

/**
 * Reads the configured managed tags plus the AppInstallation id (needed as
 * `ownerId` on the way back in — you can't hardcode it, it differs per shop).
 *
 * Reads BOTH keys in one round trip so the v1.0 fallback costs nothing.
 */
export async function readQuickTagConfig(
  admin: AdminApiContext,
): Promise<ReadConfigResult> {
  const response = await admin.graphql(READ_CONFIG_QUERY, {
    variables: {
      namespace: METAFIELD_NAMESPACE,
      configKey: CONFIG_KEY,
      legacyKey: LEGACY_TAG_KEY,
    },
  });
  const body = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        id: string;
        config: { value: string } | null;
        legacy: { value: string } | null;
      } | null;
    };
  };

  const installation = body.data?.currentAppInstallation;
  if (!installation) {
    throw new Error("Could not read the app installation from the Admin API.");
  }

  const rawConfig = installation.config?.value ?? null;
  const config = parseConfig(rawConfig);

  if (config) {
    // A blob that parsed but wasn't literally v3 came through the upgrade path
    // above, so it should be rewritten in the current shape on the next save.
    let storedVersion: unknown = null;
    try {
      storedVersion = rawConfig
        ? (JSON.parse(rawConfig) as { v?: unknown }).v
        : null;
    } catch {
      storedVersion = null;
    }

    return {
      appInstallationId: installation.id,
      managedTags: config.managedTags,
      needsUpgrade: storedVersion !== CONFIG_VERSION,
    };
  }

  const legacy = installation.legacy?.value?.trim() || null;
  return {
    appInstallationId: installation.id,
    managedTags: legacy ? [legacy] : null,
    needsUpgrade: legacy !== null,
  };
}

/**
 * Writes the managed tags. `metafieldsSet` is an upsert, so this covers both
 * the install-time seed and later edits from the Settings screen.
 *
 * VERIFIES THE WRITE rather than merely checking for errors. `metafieldsSet`
 * reports failure two ways — transport `errors` and payload `userErrors` — and
 * a third case exists where neither fires but nothing comes back. Product
 * archiving reads these values to decide what to put on a product, so
 * "probably saved" is not good enough.
 *
 * Returns a list of user-facing error messages — empty means success.
 */
export async function writeManagedTags(
  admin: AdminApiContext,
  appInstallationId: string,
  managedTags: string[],
): Promise<string[]> {
  const config: QuickTagConfig = { v: CONFIG_VERSION, managedTags };

  const response = await admin.graphql(WRITE_CONFIG_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: appInstallationId,
          namespace: METAFIELD_NAMESPACE,
          key: CONFIG_KEY,
          type: "json",
          value: JSON.stringify(config),
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
    return body.errors.map((error) => error.message);
  }

  const userErrors = body.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    return userErrors.map((error) => error.message);
  }

  const written = parseConfig(
    body.data?.metafieldsSet?.metafields?.find(
      (metafield) => metafield.key === CONFIG_KEY,
    )?.value,
  );

  const roundTripped =
    written !== null &&
    written.managedTags.length === managedTags.length &&
    written.managedTags.every((tag, index) => tag === managedTags[index]);

  if (!roundTripped) {
    return ["Shopify did not confirm the settings were saved. Try again."];
  }

  return [];
}

/**
 * Install-time seed. Called from the `afterAuth` hook in shopify.server.ts.
 *
 * Idempotent on purpose: `afterAuth` fires on every OAuth round trip (install,
 * re-install, scope change), and we must not clobber values the merchant has
 * already customised.
 *
 * DOUBLES AS THE UPGRADE. A shop on v1.0's `tag_value` string or v2's singular
 * `managedTag` surfaces through the readers above; this writes whatever it
 * found back in the current shape. Nothing is lost, and a shop that never
 * re-auths still works, because every read upgrades in memory anyway.
 */
export async function seedQuickTagConfig(
  admin: AdminApiContext,
): Promise<void> {
  const { appInstallationId, managedTags, needsUpgrade } =
    await readQuickTagConfig(admin);

  // Already on the current shape with real values — nothing to do.
  if (managedTags?.length && !needsUpgrade) return;

  const errors = await writeManagedTags(
    admin,
    appInstallationId,
    managedTags?.length ? managedTags : DEFAULT_MANAGED_TAGS,
  );
  if (errors.length) {
    throw new Error(errors.join(" "));
  }
}
