/**
 * QuickTag — Archived products.
 *
 * THE ROUTE IS STILL /app/managed AND THE COMPONENT IS STILL ManagedProducts.
 * Only the merchant-facing name changed: "Managed products" said nothing about
 * what the list holds — managed by whom, as against which other products — and
 * "archived" is the word every other surface already uses. The path stays put
 * because it is a URL merchants may have bookmarked, and renaming it buys
 * nothing they can see.
 *
 * WHERE THIS RUNS: two places, same split as the Settings screen.
 *
 *   `loader`          -> your local Node server. Holds the access token, talks
 *                        to the Admin API.
 *   `ManagedProducts` -> the merchant's browser, inside the admin's iframe,
 *                        rendering Polaris web components.
 *
 * WHAT THIS PAGE IS. A read-only list of every product QuickTag currently has
 * archived. It changes nothing: no tags, no backups, no config. Archiving and
 * restoring stay where they were — in the product-page extensions, through
 * /api/quicktag.
 *
 * WHY A ROW GOES TO THE ADMIN'S PRODUCT PAGE AND NOT TO QUICKTAG. The merchant
 * clicking a row here is asking "what is this product", not "restore it". The
 * restore decision needs the saved-tag list and the keep-newer-tags choice in
 * front of them, and those live on the product page — the block card and the
 * action modal. Sending them there is the same destination either way.
 *
 * The link is `shopify:admin/products/<id>`, App Bridge's own protocol for
 * admin-rooted URLs. The host resolves it and navigates the admin itself, so
 * the merchant stays inside the embedded session instead of getting a new tab.
 * (This is the same protocol that could NOT be made to work from inside the
 * action modal — see that file's header. The obstruction there was the product
 * page's own unsaved-changes navigation blocker fighting the modal's. There is
 * no such blocker here, which is why the documented approach simply works.)
 *
 * WHERE THE LIST COMES FROM. Not from a product query — the Admin API cannot
 * filter products by metafield. It walks the backup metafields directly and
 * reads each one's owning product. See app/quicktag-managed.server.ts, which
 * also explains why every row it returns is archived by construction.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { WhatArchivingDoes } from "../quicktag-copy";
import { listManagedProducts } from "../quicktag-managed.server";

/**
 * Formatted on the SERVER so the string is loader data rather than something
 * each side computes for itself. `toLocaleDateString` in the component would
 * run once in Node and again in the browser, against different locales and
 * timezones, and React would report a hydration mismatch on every row.
 */
function formatArchivedAt(iso: string | null): string {
  if (!iso) return "—";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const result = await listManagedProducts(admin, {
    after: url.searchParams.get("after"),
    before: url.searchParams.get("before"),
  });

  if (!result.ok) {
    return {
      ok: false as const,
      error: result.error,
      code: result.code,
    };
  }

  return {
    ok: true as const,
    products: result.page.products.map((product) => ({
      ...product,
      archivedLabel: formatArchivedAt(product.updatedAt),
    })),
    total: result.page.total,
    hasNextPage: result.page.hasNextPage,
    hasPreviousPage: result.page.hasPreviousPage,
    startCursor: result.page.startCursor,
    endCursor: result.page.endCursor,
  };
};

export default function ManagedProducts() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  // Covers both paging (a loader navigation) and the error-state retry.
  const busy =
    navigation.state === "loading" || revalidator.state === "loading";

  if (!data.ok) {
    return (
      <s-page heading="Archived products">
        <s-section heading="Couldn't load your archived products">
          {/*
            Shopify's own message and error code, verbatim. This page has one
            failure mode worth naming — the backup metafields predate the
            definition QuickTag needs to list them, and Shopify refuses to
            create it — and paraphrasing that into "something went wrong" would
            throw away the one detail that says what to do next.

            The heading names Shopify as the source rather than QuickTag's
            "index": the merchant has no idea QuickTag keeps one, and telling
            them it broke gives them a new thing to worry about and no action.
          */}
          <s-banner tone="critical" heading="Shopify reported a problem">
            <s-paragraph>{data.error}</s-paragraph>
            {data.code ? (
              <s-paragraph>
                Error code: <s-text type="strong">{data.code}</s-text>
              </s-paragraph>
            ) : null}
          </s-banner>

          <s-paragraph>
            Archiving and unarchiving are unaffected — they work from the product
            page whether or not this list loads.
          </s-paragraph>

          <s-button
            variant="primary"
            onClick={() => revalidator.revalidate()}
            {...(busy ? { loading: true } : {})}
          >
            Try again
          </s-button>
        </s-section>
      </s-page>
    );
  }

  const {
    products,
    total,
    hasNextPage,
    hasPreviousPage,
    startCursor,
    endCursor,
  } = data;

  // Guarded on the cursor rather than on hasNextPage: a missing cursor would
  // navigate to a bare /app/managed, silently dumping the merchant back on page
  // one instead of doing nothing.
  const goToNextPage = () => {
    if (!endCursor) return;
    navigate(`/app/managed?after=${encodeURIComponent(endCursor)}`);
  };

  const goToPreviousPage = () => {
    if (!startCursor) return;
    navigate(`/app/managed?before=${encodeURIComponent(startCursor)}`);
  };

  if (products.length === 0 && !hasPreviousPage) {
    return (
      <s-page heading="Archived products">
        <s-section heading="Nothing archived yet">
          <s-paragraph>
            Products appear here once QuickTag archives them.
          </s-paragraph>
          {/*
            THE MENU ITEM IS NAMED AS IT APPEARS, which is not "QuickTag". Both
            extensions take their merchant-facing name from locales/en.default.json
            — "Archive or unarchive tags" — and that is the string in the More
            actions menu and in the add-a-block picker. This paragraph told the
            merchant to look for "QuickTag", which is the app's name and appears
            in neither list. First instruction a new merchant reads, and it sent
            them hunting for something that isn't there.

            If the locale names ever change, this copy changes with them.
          */}
          <s-paragraph>
            To archive a product&apos;s tags, open it in the admin and choose{" "}
            <s-text type="strong">Archive or unarchive tags</s-text> from the
            More actions menu. QuickTag&apos;s card can be pinned to the product
            page instead — it&apos;s listed under the same name.
          </s-paragraph>
        </s-section>

        {/*
          THE EMPTY STATE GETS THE EXPLAINER TOO, and it earns its place here
          more than on either populated screen. A merchant reaching this page
          with nothing on it is either evaluating the app or has just installed
          it — the one moment they are actually asking what archiving is for.
          The mechanism sentence that used to sit in the section above was
          dropped rather than duplicated: it now reads better in the panel,
          alongside the reason anyone would want it.
        */}
        <WhatArchivingDoes />
      </s-page>
    );
  }

  return (
    <s-page heading="Archived products">
      {/*
        The count only. The page heading above already says these are archived,
        and repeating it here gave the section the same title as the page.
      */}
      <s-section
        heading={
          total === null
            ? "Products"
            : `${total} product${total === 1 ? "" : "s"}`
        }
      >
        <s-paragraph>
          Select a product to open it in the admin. Unarchiving one puts its
          saved tags back and removes it from this list.
        </s-paragraph>

        {/*
          The sort limitation, moved out of the aside to sit directly above the
          table it describes. A merchant hunting for a sort control is looking
          at the column headers, not at a side panel. The reason it can't be
          sorted — the archive date lives inside the metafield — is deliberately
          not repeated here: that explains QuickTag's storage, not their options.
        */}
        {/*
          IT DOES NOT CLAIM AN ORDER IT CANNOT PROMISE. This read "Sorted in
          Shopify's default product order", which is not what happens: the list
          walks `metafieldDefinition.metafields` (see quicktag-managed.server.ts)
          and that connection takes no sortKey, so the order is Shopify's own for
          metafields and has nothing to do with product order. A merchant
          cross-checking these rows against their product list would find they
          don't line up.
        */}
        <s-paragraph color="subdued">
          Sorted in the order Shopify returns them. Sorting isn&apos;t available
          on this list.
        </s-paragraph>

        {/*
          `paginate` is conditional, not always-on. Set unconditionally it
          renders a pair of dead arrows under a table that fits on one page —
          controls that can't do anything, which read as broken rather than as
          disabled. Shopify tells us both flags, so the row of buttons only
          appears once there is somewhere to go.
        */}
        <s-table
          variant="auto"
          {...(hasNextPage || hasPreviousPage ? { paginate: true } : {})}
          hasNextPage={hasNextPage}
          hasPreviousPage={hasPreviousPage}
          {...(busy ? { loading: true } : {})}
          onNextPage={goToNextPage}
          onPreviousPage={goToPreviousPage}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="labeled">Applied tags</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              Saved tags
            </s-table-header>
            <s-table-header listSlot="labeled">Archived</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {products.map((product, index) => {
              // clickDelegate takes the ID of a real interactive element inside
              // the row — it delegates the row's click to that element rather
              // than inventing a click target. Keyboard and screen-reader users
              // get the link itself, which is why the link has to exist.
              const linkId = `quicktag-managed-link-${index}`;

              return (
                <s-table-row key={product.productId} clickDelegate={linkId}>
                  <s-table-cell>
                    <s-link
                      id={linkId}
                      href={`shopify:admin/products/${product.adminProductId}`}
                    >
                      {product.title}
                    </s-link>
                  </s-table-cell>

                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500">
                      {product.appliedTags.map((tag) => (
                        <s-badge key={tag} tone="warning">
                          {tag}
                        </s-badge>
                      ))}
                    </s-stack>
                  </s-table-cell>

                  <s-table-cell>{product.savedTags.length}</s-table-cell>

                  <s-table-cell>{product.archivedLabel}</s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-section>

      {/*
        Was "Where this comes from", and described the $app.tag_backup metafield
        each archived product carries. See the same replacement on the settings
        screen for why that panel went: it named the storage instead of the
        guarantee, and the storage is not something a merchant can act on.

        Both facts it carried survive elsewhere, closer to where they matter —
        that a product leaves this list on restore is now in the intro paragraph
        above the table, and the sort limitation sits under the table itself,
        where someone actually looking for a sort control will find it.
      */}
      <WhatArchivingDoes />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
