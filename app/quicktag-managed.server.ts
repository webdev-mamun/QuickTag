/**
 * QuickTag — listing every product the app currently manages.
 *
 * WHERE THIS RUNS: your local Node server. Read-only with respect to products:
 * nothing in this file adds, removes, or reorders a tag, and nothing here
 * touches a product's backup metafield. It creates one metafield DEFINITION and
 * then only ever reads.
 *
 * WHY A DEFINITION AT ALL, and why this is not the obvious query.
 *
 * The obvious approach — `products(query: "…")` filtered on the backup
 * metafield — does not exist. Admin product search filters on title, tag,
 * status, vendor, sku, created_at, updated_at and friends; metafields are not
 * among them, with or without a definition. So a product-first query can only
 * ever mean "read every product in the catalogue and filter locally", which is
 * O(catalogue) on every page load.
 *
 * The metafield-first query does exist, and it is exact:
 *
 *   metafieldDefinition(identifier: {ownerType, namespace, key})
 *     .metafields(first:, after:) { nodes { value, owner { ...on Product } } }
 *
 * That walks only the metafields QuickTag actually wrote, hands back each one's
 * owning product in the same round trip, and paginates natively. Its one
 * precondition is that the namespace/key pair has a definition — which is the
 * only reason this file creates one.
 *
 * WHAT THE DEFINITION CHANGES, measured on a real store rather than assumed.
 * It is created with no `access` input, on the theory that omitting the field
 * asks for app-private — `MetafieldAccessInput.admin` cannot even express
 * PRIVATE, its only values being MERCHANT_READ and MERCHANT_READ_WRITE.
 *
 * That theory was WRONG. The created definition comes back as:
 *
 *     access: { admin: "MERCHANT_READ" }
 *
 * So the merchant gains read access to the backup metafield through the Admin
 * API, where an undefined `$app` metafield had been invisible to them. It
 * cannot be configured away: MERCHANT_READ is the most restrictive value the
 * input accepts, on create AND on update. Any definition on this key is at
 * least merchant-readable.
 *
 * Checked on the store this was built against: Shopify does not render it in
 * the product page's Metafields section, so in practice the metafield stays out
 * of the merchant's way. Accepted on that basis. If it ever does surface there,
 * the fix is not in this file — it is dropping the definition entirely and
 * listing managed products another way (an index metafield the archive/restore
 * flow maintains, or a bounded catalogue scan).
 *
 * WHY PRESENCE IS ENOUGH, with no filtering on `tagState`. Restore DELETES the
 * backup metafield once it has verified the saved tags are back
 * (`deleteBackup` in quicktag-archive.server.ts). A backup metafield therefore
 * exists if and only if the product is archived. Every node this connection
 * returns is a managed product; there is no archived/active flag to filter on
 * and no stale row to skip. The version guard in `parseBackup` still runs, so a
 * value QuickTag can't read is dropped rather than rendered as a broken row.
 *
 * THE RISK THIS FILE WAS BUILT AROUND, now resolved.
 * `metafieldDefinitionCreate` has an error code, UNSTRUCTURED_ALREADY_EXISTS,
 * for "this namespace and key combination is already in use for a set of your
 * metafields" — precisely the state of a shop that archived products under
 * v1.1, before this page existed. It does NOT fire: the definition was created
 * over five pre-existing unstructured backups on a real store and adopted all
 * five, which then listed correctly. Definitions do absorb existing metafields.
 *
 * The verbatim error reporting below stays anyway. A silent empty table would
 * be indistinguishable from "nothing is archived", which is the one wrong
 * answer this page must never give.
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { METAFIELD_NAMESPACE } from "./quicktag.server";
import { BACKUP_KEY, parseBackup } from "./quicktag-archive.server";

/** Merchant-invisible, but it shows up in app-owned definition listings. */
const DEFINITION_NAME = "QuickTag archive backup";
const DEFINITION_DESCRIPTION =
  "Tags QuickTag saved when this product was archived, and the tags it applied in their place.";

/**
 * Rows per page. Shopify allows up to 250 on this connection; 20 keeps the
 * round trip small and the table readable, and the merchant is paging through
 * archived products, not scrolling a catalogue.
 */
export const PAGE_SIZE = 20;

const DEFINITION_IDENTIFIER = {
  ownerType: "PRODUCT",
  namespace: METAFIELD_NAMESPACE,
  key: BACKUP_KEY,
};

export interface ManagedProduct {
  /** `gid://shopify/Product/123` — the API form. */
  productId: string;
  /** `123` — what a shopify:admin URL needs. */
  adminProductId: string;
  title: string;
  appliedTags: string[];
  savedTags: string[];
  /** From the backup blob, i.e. when QuickTag archived it. */
  updatedAt: string | null;
}

export interface ManagedPage {
  products: ManagedProduct[];
  /** Total across all pages. Null if Shopify didn't return a count. */
  total: number | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export type ManagedListResult =
  | { ok: true; page: ManagedPage }
  | {
      ok: false;
      error: string;
      /** Shopify's own userError code, when there was one. Shown to the merchant. */
      code: string | null;
    };

const LIST_QUERY = `#graphql
  query QuickTagManagedProducts(
    $identifier: MetafieldDefinitionIdentifierInput!
    $first: Int
    $after: String
    $last: Int
    $before: String
  ) {
    metafieldDefinition(identifier: $identifier) {
      id
      metafieldsCount
      metafields(first: $first, after: $after, last: $last, before: $before) {
        nodes {
          id
          value
          owner {
            ... on Product {
              id
              title
            }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  }
`;

const CREATE_DEFINITION_MUTATION = `#graphql
  mutation QuickTagCreateBackupDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
        access {
          admin
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldNode {
  id: string;
  value: string | null;
  owner: {
    id?: string;
    title?: string;
  } | null;
}

interface ListResponse {
  data?: {
    metafieldDefinition?: {
      id: string;
      metafieldsCount: number | null;
      metafields: {
        nodes: MetafieldNode[];
        pageInfo: {
          hasNextPage: boolean;
          hasPreviousPage: boolean;
          startCursor: string | null;
          endCursor: string | null;
        };
      };
    } | null;
  };
  errors?: { message: string }[];
}

/** `gid://shopify/Product/123` -> `123`. Empty string if the id isn't a gid. */
function toAdminProductId(gid: string): string {
  const last = gid.split("/").pop();
  return last && /^\d+$/.test(last) ? last : "";
}

/**
 * Turns one metafield node into a row, or null if it can't be rendered.
 *
 * Dropped rather than rendered: a node whose owner isn't a Product (the owner
 * field is a union across every metafield owner type), and a value that fails
 * the v2 guard in parseBackup. Both are "shouldn't happen" cases, and a missing
 * row is a better failure than a row with blank cells.
 */
function toManagedProduct(node: MetafieldNode): ManagedProduct | null {
  const owner = node.owner;
  if (!owner?.id || !owner.title) return null;

  const backup = parseBackup(node.value);
  if (!backup) return null;

  return {
    productId: owner.id,
    adminProductId: toAdminProductId(owner.id),
    title: owner.title,
    appliedTags: backup.appliedTags,
    savedTags: backup.savedTags,
    updatedAt: backup.updatedAt,
  };
}

/**
 * Runs the list query. Returns `null` — distinct from an empty page — when the
 * definition doesn't exist yet, which is the caller's cue to create it.
 */
async function queryManagedPage(
  admin: AdminApiContext,
  cursor: { after?: string | null; before?: string | null },
): Promise<ManagedPage | null> {
  // Exactly one of first/last may be set on a Relay connection. Passing the
  // other as null is fine; passing both is an error.
  const variables = cursor.before
    ? {
        identifier: DEFINITION_IDENTIFIER,
        first: null,
        after: null,
        last: PAGE_SIZE,
        before: cursor.before,
      }
    : {
        identifier: DEFINITION_IDENTIFIER,
        first: PAGE_SIZE,
        after: cursor.after ?? null,
        last: null,
        before: null,
      };

  const response = await admin.graphql(LIST_QUERY, { variables });
  const body = (await response.json()) as ListResponse;

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join(" "));
  }

  const definition = body.data?.metafieldDefinition;
  if (!definition) return null;

  return {
    products: definition.metafields.nodes
      .map(toManagedProduct)
      .filter((product): product is ManagedProduct => product !== null),
    total: definition.metafieldsCount ?? null,
    hasNextPage: definition.metafields.pageInfo.hasNextPage,
    hasPreviousPage: definition.metafields.pageInfo.hasPreviousPage,
    startCursor: definition.metafields.pageInfo.startCursor,
    endCursor: definition.metafields.pageInfo.endCursor,
  };
}

/**
 * Creates the definition. Returns null on success, or a `{error, code}` pair
 * carrying Shopify's own words — see the file header for why they are passed
 * through rather than replaced with something friendlier.
 *
 * `access` is deliberately absent from the input: that is what keeps the
 * definition app-private. The response's `access { admin }` is logged so a
 * change in that default is visible in server output rather than discovered by
 * a merchant finding the metafield in their admin.
 */
async function createBackupDefinition(
  admin: AdminApiContext,
): Promise<{ error: string; code: string | null } | null> {
  const response = await admin.graphql(CREATE_DEFINITION_MUTATION, {
    variables: {
      definition: {
        name: DEFINITION_NAME,
        description: DEFINITION_DESCRIPTION,
        namespace: METAFIELD_NAMESPACE,
        key: BACKUP_KEY,
        ownerType: "PRODUCT",
        type: "json",
      },
    },
  });
  const body = (await response.json()) as {
    data?: {
      metafieldDefinitionCreate?: {
        createdDefinition: {
          id: string;
          namespace: string;
          access: { admin: string } | null;
        } | null;
        userErrors: {
          field: string[] | null;
          message: string;
          code: string | null;
        }[];
      };
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    return {
      error: body.errors.map((error) => error.message).join(" "),
      code: null,
    };
  }

  const userErrors = body.data?.metafieldDefinitionCreate?.userErrors ?? [];
  const first = userErrors[0];

  // TAKEN means another request created it a moment ago — two tabs, two
  // loaders. The definition exists, which is all this function was for.
  if (first && first.code !== "TAKEN") {
    return { error: first.message, code: first.code ?? null };
  }

  const created = body.data?.metafieldDefinitionCreate?.createdDefinition;
  if (created) {
    console.log(
      `QuickTag: created the backup metafield definition (${created.namespace}.${BACKUP_KEY}), admin access = ${
        created.access?.admin ?? "unspecified"
      }.`,
    );
  }

  return null;
}

/**
 * The page's one data call.
 *
 * Creates the definition on first use rather than at install time, so shops
 * already running v1.1 pick it up without re-authing, and so shopify.server.ts
 * keeps its current install sequence. After the first successful load the
 * definition exists and this is a single query.
 */
export async function listManagedProducts(
  admin: AdminApiContext,
  cursor: { after?: string | null; before?: string | null } = {},
): Promise<ManagedListResult> {
  try {
    const existing = await queryManagedPage(admin, cursor);
    if (existing) return { ok: true, page: existing };

    const failure = await createBackupDefinition(admin);
    if (failure) {
      return { ok: false, error: failure.error, code: failure.code };
    }

    const created = await queryManagedPage(admin, cursor);
    if (created) return { ok: true, page: created };

    return {
      ok: false,
      // "Index" was QuickTag's word for the metafield definition, not one the
      // merchant has ever been shown. Telling them it broke handed them a new
      // thing to worry about and no action to take; the retry is the only part
      // they can act on, so it is the only part left.
      error: "Shopify hasn't finished setting this up. Try again in a moment.",
      code: null,
    };
  } catch (caught) {
    return {
      ok: false,
      error:
        caught instanceof Error
          ? caught.message
          : "Your archived products could not be loaded.",
      code: null,
    };
  }
}
