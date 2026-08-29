/**
 * QuickTag — the app's public landing page. `/`
 *
 * WHERE THIS RUNS: your Node server, in an ordinary browser page. NOT inside
 * the Shopify admin's iframe and NOT behind `authenticate.admin` — this is the
 * one screen in the app a person can reach without being an authenticated
 * merchant, which is why it renders plain HTML and its own CSS instead of
 * Polaris web components. Everything under `/app` is the opposite on all three
 * counts.
 *
 * THE LOADER IS THE POINT OF THIS FILE, not the markup. A request carrying
 * `?shop=` is a merchant arriving from Shopify, and it is redirected straight
 * to `/app` without rendering a pixel below. That redirect is the real
 * merchant path; everything else here is what a person sees who opened the app
 * URL with no shop attached.
 *
 * THERE IS NO LOG-IN FORM, and it was removed rather than never added. The
 * template ships one here — a shop-domain field posting to `/auth/login`.
 * Three reasons it is gone:
 *
 *   - `distribution` is `AppDistribution.SingleMerchant` (see
 *     app/shopify.server.ts). A custom app is installed from a one-time link
 *     in the Partner Dashboard. No merchant ever installs it by typing their
 *     shop domain into a form.
 *   - No merchant could reach it anyway. The redirect above fires first for
 *     every request that has a shop, which is every request from the admin.
 *   - It duplicated app/routes/auth.login/route.tsx, which renders the same
 *     field and additionally shows the validation errors that `login()`
 *     returns. The copy here had no error display at all: a mistyped domain
 *     submitted from this page was only ever reported by the other route.
 *
 * `/auth/login` is untouched and still reachable, so nothing about the auth
 * flow changed — only the second, worse doorway into it.
 *
 * WHAT THE COPY HAS TO GET RIGHT. The same vocabulary rules the in-app copy
 * follows, for the same reason, and they matter MORE here because this is the
 * first sentence anyone reads about the app:
 *
 *   - THE OBJECT IS "TAGS", NEVER "THIS PRODUCT". Shopify has already defined
 *     "archive a product" to mean unpublish it. The h1 leads on that
 *     distinction ("not the product") rather than leaving it to be discovered,
 *     because a merchant who misreads this headline misunderstands the whole
 *     app.
 *   - ARCHIVE / UNARCHIVE, NEVER "RESTORE". See app/quicktag-copy.tsx for the
 *     full rule; the short version is that prose has to match the buttons, and
 *     the buttons say Unarchive.
 *
 * WHAT THE THREE FEATURES CLAIM, and why each is safe to say:
 *
 *   "Active, Draft and Archived are left exactly as they are" — verified in
 *   app/quicktag-archive.server.ts, which runs exactly four mutations
 *   (metafieldsSet, metafieldsDelete, tagsAdd, tagsRemove) and touches product
 *   status in none of them.
 *
 *   "saved and confirmed before any are removed … checked again on the way
 *   back" — the literal ordering contract of archiveProduct and
 *   restoreProduct. Not marketing: the backup write is round-trip confirmed
 *   before the first tag comes off, and the saved tags are re-read from
 *   Shopify and verified before the backup is deleted.
 *
 *   THE RESERVED-TAGS RULE IS DELIBERATELY NOT HERE. It is a real cost and it
 *   is stated twice in the app — on the settings card beside the field where
 *   the tags are chosen, and in the explainer panel. Both of those are at the
 *   point of decision, where a merchant can still act on it. A caveat on a
 *   landing page is read by nobody who is choosing a tag.
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <main className={styles.content}>
        <p className={styles.eyebrow}>QuickTag</p>

        <h1 className={styles.heading}>
          Archive a product&apos;s tags, not the product.
        </h1>

        <p className={styles.text}>
          Swap a product&apos;s tags for your archive tags so it drops out of
          automated collections and storefront filters. It stays published the
          whole time — and unarchiving puts the original tags back.
        </p>

        <ul className={styles.list}>
          <li className={styles.listItem}>
            <h2 className={styles.listHeading}>Only the tags change</h2>
            <p className={styles.listText}>
              QuickTag never changes a product&apos;s status. Active, Draft and
              Archived in Shopify are left exactly as they are.
            </p>
          </li>
          <li className={styles.listItem}>
            <h2 className={styles.listHeading}>Nothing gets lost</h2>
            <p className={styles.listText}>
              Tags are saved and confirmed before any are removed, then checked
              again on the way back before the saved copy is cleared.
            </p>
          </li>
          <li className={styles.listItem}>
            <h2 className={styles.listHeading}>Two ways in</h2>
            <p className={styles.listText}>
              Archive from the More actions menu on any product, or pin
              QuickTag&apos;s card to the product page and do it in place.
            </p>
          </li>
        </ul>
      </main>
    </div>
  );
}
