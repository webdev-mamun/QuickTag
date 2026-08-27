/**
 * QuickTag — shared merchant-facing copy.
 *
 * WHY THIS FILE EXISTS. Until now the app explained its mechanism in four
 * places and its purpose in none. Every surface described what QuickTag does to
 * the data — saves the tags, removes them, applies a tag in their place, writes
 * a metafield — and no surface said why a merchant would want any of that.
 *
 * The answer is one paragraph long and it is below. It is a module rather than
 * a string copied into each route because an explanation that exists three
 * times is an explanation that will be true in one place and stale in the other
 * two. The extensions can't import it (they compile to their own bundles, on
 * Shopify's infrastructure — see extensions/*\/src/quicktag-api.ts for the same
 * constraint), but the app routes can, and they are where it belongs: the
 * settings screen and the archived-products screen are the two places a
 * merchant goes to find out what this app is.
 *
 * WHAT THE COPY CLAIMS, and why each claim is safe to make:
 *
 *   "never changes a product's status" — verified against
 *   quicktag-archive.server.ts. The archive path runs exactly four mutations:
 *   metafieldsSet and metafieldsDelete for the backup, tagsAdd and tagsRemove
 *   for the tags. Nothing touches product status or publication. If that ever
 *   changes, this sentence becomes a lie and has to change with it.
 *
 *   IT NAMES SHOPIFY'S THREE STATUSES, and that is the point of it rather than
 *   a detail. "Only the tags change" is a claim about QuickTag; a merchant
 *   worried that this app unpublishes their products is worried about a
 *   specific control they can see, and a denial that never names Active /
 *   Draft / Archived does not answer them. This paragraph was on the settings
 *   card as an info banner, next to the copy that caused the fear. The copy is
 *   gone and the panel is where the explaining happens, so it lives here.
 *
 *   "Archiving IN QUICKTAG" — the two words carrying the disambiguation, and
 *   the reason the sentence opens on them. The panel explains what archiving
 *   does; it never said whose archiving, on a screen that also carries
 *   Shopify's own Archive control. A merchant who reads the first sentence and
 *   stops still learns which archive is meant. Don't trim it back to
 *   "Archiving swaps" — the sentence is not redundant with the heading above
 *   it, it is what makes the heading unambiguous.
 *
 *   "puts YOUR ORIGINAL TAGS back", not "every original tag". The stronger
 *   word was wrong, and the paragraph below it is the reason: an archive tag
 *   the product already carried is not an original tag as far as QuickTag is
 *   concerned — it is excluded from the snapshot and removed on restore. "Every"
 *   promised the one case that is guaranteed not to hold.
 *
 *   THE RESERVED-TAGS PARAGRAPH is the merchant-facing half of a design rule,
 *   not a warning about a bug. The rule lives in quicktag-archive.server.ts: a
 *   tag QuickTag applies is QuickTag's, whether or not the product already had
 *   it. That is predictable — the alternative makes a tag's fate depend on
 *   per-product history the merchant cannot see — and the cost of it is a real
 *   tag being stripped from products that had it.
 *
 *   USED TO BE STATED TWICE ON THE SAME SCREEN, WORDED DIFFERENTLY, WHICH READ
 *   AS A DUPLICATE RATHER THAN AS TWO ANSWERS. The settings card and this
 *   paragraph both carried the warning, on the theory that they answer
 *   different questions — consequence-first for a merchant mid-decision,
 *   rule-first for a merchant reading the panel. In practice a merchant
 *   scrolling the settings page just sees the same warning twice. Settings now
 *   shows it ONCE, as a warning banner next to the field it constrains
 *   (`hideReservedTagsNote` suppresses this paragraph there); Archived products
 *   has no such banner, so this paragraph is still its only mention of the
 *   rule.
 *
 *   "drops out of those" — deliberately scoped, and the scope is the two things
 *   named in the same sentence. Automated collections and storefront filters key
 *   off tags, so removing a tag stops a product matching the rules that named it.
 *   It does NOT claim the product leaves every collection: a manual collection,
 *   or an automated one keyed on price or vendor, is unaffected. Keep the
 *   antecedent in the sentence — "drops out of anything that matched" was the
 *   wider claim, and it was wrong.
 */

/**
 * THE VERB IS "ARCHIVE" AND THE OBJECT IS ALWAYS "TAGS". Settled deliberately;
 * don't drift off it.
 *
 * THE PROBLEM. Shopify's own product status is Active / Draft / Archived, and
 * archiving a product there unpublishes it. QuickTag does something far
 * narrower — it moves tags — but it used to say "Archive" on a button sitting
 * on the same page as Shopify's control, and "Archived" on the banner
 * confirming success. A merchant could reasonably read either as "my product is
 * now offline", and act on that belief.
 *
 * WHAT WAS CONSIDERED. Renaming the verb outright — Hold/Release, Park/Unpark —
 * which removes the collision completely. It was rejected, and not on cost: the
 * app is unpublished, there is no listing and there are no merchants, so a
 * rename is about as cheap now as it will ever be.
 *
 * It was rejected because the verb was never the thing that was wrong. "Archive"
 * already means "set aside, still there, retrievable" in every context a
 * merchant knows — email, files, and Shopify itself. That is exactly what
 * QuickTag does to tags. Hold or Park would be new vocabulary carrying no
 * meaning until the merchant learns it, traded for a word that already carries
 * the right one.
 *
 * What was actually wrong was the OBJECT. The app said it archived a *product*
 * when it archives a product's *tags* — and "archive this product" is precisely
 * the phrase Shopify has already defined to mean something else. Bind the verb
 * to "tags" and the collision cannot occur: "Archive tags" has no reading in
 * which the product is unpublished.
 *
 * THE RULE. Anywhere a merchant acts or is told what happened — buttons, modal
 * headings, success banners, error headings, server refusals — the noun is
 * "tags". Never "archive this product".
 *
 * THE EXCEPTION IS NAMES OF SETS, NOT DESCRIPTIONS OF THE ACTION: the
 * "Archived products" page title, "Nothing archived yet", the table's columns.
 * These name a collection rather than saying what QuickTag does to it, no
 * button is adjacent, and this panel is on screen to say what it means.
 *
 * READ AS "ANY DESCRIPTIVE SENTENCE", the exception swallows the rule — and it
 * did. The settings field's own description was trimmed to "The tags QuickTag
 * adds when you archive a product", which describes rather than commands and so
 * looked exempt, while telling the merchant that QuickTag fires when they use
 * Shopify's Archive. A sentence with archiving as its VERB takes "tags" as its
 * object, whether or not a button is next to it.
 */

/**
 * THE PAIR IS ARCHIVE / UNARCHIVE. "RESTORE" IS NOT A MERCHANT-FACING WORD.
 *
 * THE PROBLEM IT FIXES. The buttons have always said Archive and Unarchive, but
 * every sentence ABOUT them said restore — this panel, the Archived products
 * page, and four server error messages, one of which told the merchant that
 * "Restore will put this product back" while the only control on screen said
 * Unarchive. Nothing in the app was named Restore. A merchant reading the two
 * vocabularies has no way to know they are one feature, and the error message
 * sent them looking for a button that does not exist.
 *
 * WHY UNARCHIVE WON. Not because it is the better word — "restore" says what
 * happens to the tags more plainly, and would have been a defensible choice for
 * both the copy AND the buttons. It won because the buttons are the surface a
 * merchant acts on, and prose has to match the thing they press. Renaming the
 * buttons instead would have meant retiring "unarchive" from the two extensions
 * and the block card's own state sentence, for no gain.
 *
 * THE RULE. Merchant-facing text uses archive / unarchive, in every form:
 * "Unarchive puts them back", "Unarchiving one puts its saved tags back", "try
 * unarchiving again". The gerund is "unarchiving", never "restoring".
 *
 * THE CODE KEEPS "RESTORE", deliberately and without exception:
 * `restoreProduct`, `intent: "restore"`, `restoreProduct`'s own comments, the
 * `/api/quicktag` payload. Those are internal names for a sequence, they are
 * stable across whatever the buttons end up saying, and churning them would
 * touch both extensions and the endpoint for a rename no merchant can see. The
 * line is exactly this: a string a merchant can read follows the button; an
 * identifier does not.
 */

/**
 * The canonical explanation, as an aside panel.
 *
 * Rendered into the `aside` slot of an `s-page`. `children` is appended after
 * the fixed paragraphs so a page can add its own note under the same
 * heading. No caller passes one: the settings page did, and that note was cut
 * with the rest of the card's prose. The slot stays because the next page to
 * need one will need it here.
 */
export function WhatArchivingDoes({
  hideReservedTagsNote = false,
  children,
}: {
  /**
   * Settings passes `true`. Its own tag field already carries this warning as
   * a banner (see app._index.tsx), and repeating it here read as the same
   * warning twice on one screen. Archived products has no such banner, so it
   * leaves this at its default and keeps the paragraph as its only mention.
   */
  hideReservedTagsNote?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <s-section slot="aside" heading="What archiving does">
      <s-paragraph>
        Archiving in QuickTag swaps a product&apos;s tags for yours. Only the
        tags change.
      </s-paragraph>
      <s-paragraph>
        QuickTag never changes a product&apos;s status — Active, Draft, or
        Archived in Shopify stay exactly as they are.
      </s-paragraph>
      <s-paragraph>
        Tags drive automated collections and storefront filters, so the product
        drops out of those. Unarchiving puts your original tags back.
      </s-paragraph>
      {hideReservedTagsNote ? null : (
        <s-paragraph>
          Archive tags belong to QuickTag: unarchiving strips them even from
          products that already had one, so don&apos;t reuse them elsewhere.
        </s-paragraph>
      )}
      {children}
    </s-section>
  );
}
