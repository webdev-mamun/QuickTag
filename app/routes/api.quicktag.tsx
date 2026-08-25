/**
 * QuickTag — the shared archive/restore endpoint. `/api/quicktag`
 *
 * WHERE THIS RUNS: your local Node server. This is the ONE place both
 * extensions go for state and for writes, and it is the reason neither of them
 * contains an archive or restore sequence of its own.
 *
 * HOW THE EXTENSIONS REACH IT. An admin UI extension executes in a sandbox on
 * Shopify's infrastructure and cannot import a line of `app/`, but it can call
 * this app over HTTP:
 *
 *   - `fetch("/api/quicktag")` from an extension resolves RELATIVE TO the app's
 *     `application_url`, so neither extension has to know or embed the tunnel
 *     URL — which changes on every `shopify app dev` anyway.
 *   - Shopify attaches an `Authorization: Bearer <OIDC ID token>` header
 *     automatically on requests to the app's own domain. There is no
 *     `auth.idToken()` plumbing in either extension because there doesn't need
 *     to be.
 *   - `authenticate.admin` exchanges that token for an Admin API context, and
 *     the `cors` helper it returns puts the headers on the reply that let the
 *     sandbox's origin read it.
 *
 * WHY IT SPEAKS JSON RATHER THAN FORM DATA. `keepNewerTags` is a boolean whose
 * two values do materially different things to a merchant's data. Round-
 * tripping that through `"true"`/`"false"` strings is one typo away from the
 * destructive branch running when the merchant asked for the safe one.
 *
 * A NOTE ON PREFLIGHT. React Router routes only GET and the mutation methods,
 * so an `OPTIONS` request never reaches this file. Shopify's extension fetch is
 * documented as the supported way to call an app backend and `cors()` is the
 * documented server half, so the sanctioned path is exactly this. If a browser
 * preflight ever does surface, the fix is an `OPTIONS` handler in a custom
 * server entry — not a change here.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { DEFAULT_MANAGED_TAGS, readQuickTagConfig } from "../quicktag.server";
import {
  archiveProduct,
  readProductTagState,
  restoreProduct,
  type QuickTagErrorCode,
  type QuickTagResult,
} from "../quicktag-archive.server";

/**
 * Status codes exist so a failed call is legible in a network log. The
 * extensions branch on `code`, never on the status.
 */
const STATUS_BY_CODE: Record<QuickTagErrorCode, number> = {
  no_product: 404,
  invalid_tag: 400,
  already_archived: 409,
  not_archived: 409,
  backup_write_failed: 502,
  tag_write_failed: 502,
  verify_failed: 422,
  backup_clear_failed: 502,
};

type EnsureCors = (response: Response) => Response;

/**
 * `cors()` from the SDK sets Allow-Origin and Allow-Headers. Allow-Methods is
 * added here so the response is self-describing to anything inspecting it.
 */
function reply(
  cors: EnsureCors,
  payload: unknown,
  status = 200,
): Response {
  const response = cors(Response.json(payload, { status }));
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return response;
}

/** Adds `managedTags` to every reply — the Archive modal pre-fills from them. */
function toPayload(result: QuickTagResult, managedTags: string[]) {
  return result.ok
    ? { ok: true as const, managedTags, state: result.state }
    : {
        ok: false as const,
        managedTags,
        code: result.code,
        error: result.error,
        state: result.state ?? null,
      };
}

/**
 * GET /api/quicktag?productId=gid://shopify/Product/123
 *
 * Serves both extensions' render path and the block's poll. Returns the
 * product's tag state plus the shop's default managed tag in one round trip.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, cors } = await authenticate.admin(request);

  const productId = new URL(request.url).searchParams.get("productId");
  const { managedTags } = await readQuickTagConfig(admin);
  const resolvedManagedTags = managedTags?.length
    ? managedTags
    : DEFAULT_MANAGED_TAGS;

  if (!productId) {
    return reply(
      cors,
      {
        ok: false as const,
        managedTags: resolvedManagedTags,
        code: "no_product" as const,
        error: "No product was given.",
        state: null,
      },
      400,
    );
  }

  const state = await readProductTagState(admin, productId);
  if (!state) {
    return reply(
      cors,
      {
        ok: false as const,
        managedTags: resolvedManagedTags,
        code: "no_product" as const,
        error: "That product could not be read.",
        state: null,
      },
      404,
    );
  }

  return reply(cors, { ok: true as const, managedTags: resolvedManagedTags, state });
};

/**
 * POST /api/quicktag
 *
 *   { "intent": "archive", "productId": "gid://…", "appliedTags": ["Sold out"] }
 *   { "intent": "restore", "productId": "gid://…", "keepNewerTags": true }
 *
 * `appliedTags` are whatever the merchant confirmed in the modal — the
 * pre-filled defaults or their one-time edit. Either way they are written to
 * the product's backup and NEVER back to the shop's `managedTags`.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, cors } = await authenticate.admin(request);

  const { managedTags } = await readQuickTagConfig(admin);
  const resolvedManagedTags = managedTags?.length
    ? managedTags
    : DEFAULT_MANAGED_TAGS;

  const fail = (code: QuickTagErrorCode, error: string) =>
    reply(
      cors,
      {
        ok: false as const,
        managedTags: resolvedManagedTags,
        code,
        error,
        state: null,
      },
      STATUS_BY_CODE[code],
    );

  let body: {
    intent?: unknown;
    productId?: unknown;
    appliedTags?: unknown;
    keepNewerTags?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("invalid_tag", "The request body could not be read.");
  }

  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) {
    return fail("no_product", "No product was given.");
  }

  let result: QuickTagResult;

  switch (body.intent) {
    case "archive": {
      // Falls back to the shop defaults when the modal sends nothing usable, so
      // a UI bug can never archive a product with no mark on it at all. The
      // server validates the list again either way.
      const submitted = Array.isArray(body.appliedTags)
        ? body.appliedTags.filter(
            (tag): tag is string => typeof tag === "string" && tag.trim() !== "",
          )
        : [];
      const appliedTags = submitted.length ? submitted : resolvedManagedTags;

      result = await archiveProduct(admin, { productId, appliedTags });
      break;
    }

    case "restore": {
      // Defaults to the SAFE branch. Only an explicit `false` removes tags the
      // merchant added after archiving.
      const keepNewerTags = body.keepNewerTags !== false;

      result = await restoreProduct(admin, { productId, keepNewerTags });
      break;
    }

    default:
      return fail("invalid_tag", "Unknown action.");
  }

  return reply(
    cors,
    toPayload(result, resolvedManagedTags),
    result.ok ? 200 : STATUS_BY_CODE[result.code],
  );
};
