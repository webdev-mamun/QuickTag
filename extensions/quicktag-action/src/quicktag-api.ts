/**
 * QuickTag — transport shim for the app backend.
 *
 * WHAT IS *NOT* IN THIS FILE, deliberately: any part of archiving or restoring.
 * Both sequences — snapshot, verify, apply, remove, verify again, clear — live
 * in app/quicktag-archive.server.ts and are reached through /api/quicktag.
 * Extensions describe intent; the server decides and writes. That is the whole
 * reason this file is thin.
 *
 * MIRRORED, NOT SHARED. A byte-identical copy lives in the other extension's
 * src/. The Shopify CLI compiles each extension directory into its own bundle,
 * so there is no import path between them and no way to share a module without
 * inventing a package the CLI would also have to be taught to ignore. This
 * transport shim is the one piece of QuickTag that exists twice on purpose —
 * keep the two copies in step.
 *
 * HOW THE CALL REACHES THE APP. Extensions run in a sandbox on Shopify's
 * infrastructure, not on your server, but `fetch` with a relative path resolves
 * against the app's `application_url` — so the tunnel URL, which changes on
 * every `shopify app dev`, never appears in this bundle. Shopify also attaches
 * `Authorization: Bearer <OIDC ID token>` automatically on requests to the
 * app's own domain, which is why there is no `shopify.auth.idToken()` call
 * here.
 */

const ENDPOINT = "/api/quicktag";

/** Mirrors ProductTagState in app/quicktag-archive.server.ts. */
export interface ProductTagState {
  productId: string;
  title: string;
  /** The product's tags right now, in Shopify's own casing. */
  tags: string[];
  tagState: "active" | "archived";
  /** The snapshot taken at archive time. Empty unless archived. */
  savedTags: string[];
  /** The tags QuickTag actually applied to THIS product. Restore keys off them. */
  appliedTags: string[];
  updatedAt: string | null;
  /** Tags added since archiving. Non-empty is what puts the Restore choice on screen. */
  newerTags: string[];
}

export interface QuickTagResponse {
  ok: boolean;
  /** The shop-wide DEFAULT tags. The Archive editor pre-fills from them. */
  managedTags: string[];
  state: ProductTagState | null;
  code?: string;
  error?: string;
}

export type QuickTagRequest =
  | { intent: "archive"; productId: string; appliedTags: string[] }
  | { intent: "restore"; productId: string; keepNewerTags: boolean };

/**
 * Mirrors validateTag in app/quicktag.server.ts, so the merchant sees a bad tag
 * before spending a round trip. The server validates again and is the authority
 * — this copy exists for the error message, not for safety.
 *
 * THE COMMA RULE IS NOT COSMETIC: Shopify splits tag input on commas, so
 * "Sold out, clearance" would become two tags while QuickTag recorded one
 * applied tag matching neither, and Restore would never find it. Multiple tags
 * are expressed as multiple entries, which is why a comma inside one is wrong.
 */
export function validateTagInput(
  value: string,
): { tag: string } | { error: string } {
  const tag = value.trim();

  if (!tag) {
    return { error: "Enter a tag." };
  }
  if (tag.includes(",")) {
    return {
      error: "Tags can't contain commas — add them one at a time instead.",
    };
  }
  if (tag.length > 255) {
    return { error: "Tags can be at most 255 characters." };
  }
  return { tag };
}

/**
 * The backend answers JSON on every path, successes and failures alike. Any
 * other body means the request never arrived — an auth redirect rendering an
 * HTML page, a dead dev tunnel — and must not be read as a result, least of all
 * as a successful one.
 */
async function readResponse(response: Response): Promise<QuickTagResponse> {
  let body: Partial<QuickTagResponse> | null = null;
  try {
    body = (await response.json()) as Partial<QuickTagResponse>;
  } catch {
    body = null;
  }

  if (!body || typeof body.ok !== "boolean") {
    throw new Error(
      "QuickTag couldn't reach its backend. Check that the app is running, then try again.",
    );
  }

  return {
    ok: body.ok,
    managedTags: Array.isArray(body.managedTags)
      ? body.managedTags.filter((tag): tag is string => typeof tag === "string")
      : [],
    state: body.state ?? null,
    code: body.code,
    error: body.error,
  };
}

/** Reads the product's tag state and the shop's default tag in one round trip. */
export async function loadQuickTagState(
  productId: string,
): Promise<QuickTagResponse> {
  const response = await fetch(
    `${ENDPOINT}?productId=${encodeURIComponent(productId)}`,
  );
  return readResponse(response);
}

/** Runs an archive or restore. The server owns every decision inside it. */
export async function submitQuickTag(
  request: QuickTagRequest,
): Promise<QuickTagResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readResponse(response);
}
