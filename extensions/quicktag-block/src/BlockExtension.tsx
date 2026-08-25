/**
 * QuickTag — product details block extension. Status card.
 *
 * WHERE THIS RUNS: same place as the action extension — Shopify's own
 * infrastructure, in a sandboxed worker inside the admin page, not on your
 * machine. It cannot `import` anything from `app/`. It reaches the app's
 * backend over HTTP instead; see src/quicktag-api.ts.
 *
 * WHAT THIS CARD IS FOR: telling the truth about a product's archive state and
 * changing it, in place, with no dialog and no page reload. It decides nothing
 * about tags — every archive and restore sequence lives in
 * app/quicktag-archive.server.ts behind /api/quicktag, and the action extension
 * calls the same endpoint. One backend sequence, two front doors.
 *
 * THE RESULT IS REPORTED ON THE CARD, NOT IN A DIALOG. The button is pressed, a
 * spinner stands in for the card's body, and what comes back is the card
 * describing the product's new state — "Press Archive to save and remove this
 * product's 5 tags" where a moment ago it said Unarchive — plus a success
 * banner that retires itself after REFRESH_NOTE_MS.
 *
 * THE BANNER IS NOT REDUNDANT WITH THE SENTENCE, though it nearly was. It
 * carries the one thing the card cannot show: that Shopify's own Tags card is
 * still displaying pre-write data. Without that, a merchant who archives and
 * looks at Shopify's Tags card sees every tag QuickTag just removed, still
 * listed, and concludes the app is broken.
 *
 * FAILURES GET A BANNER TOO, and that one stays. Nothing else on the card would
 * change, so without it a failed write is indistinguishable from one that
 * worked — and unlike a success, a failure is something the merchant has to act
 * on.
 *
 * WHY THE RESULT IS NOT REPORTED IN A POPUP, which was the first choice: a
 * block cannot raise one. `s-modal` is allowed on exactly one admin target —
 * the per-target component allowlists in
 * @shopify/ui-extensions/build/ts/surfaces/admin/targets/ are the record, and
 * only admin.app.home.render imports components/Modal.d.ts. This target's list
 * runs to 57 components and Modal is not among them; `<s-modal>` here is a
 * TS2339 at compile time, never mind runtime.
 *
 * The one dialog a block CAN open is an action extension, through
 * `shopify.navigation.navigate` — and it cannot be used to report this result.
 * An action reads product state when it opens and has no way to be told that a
 * write just happened: there is no launch parameter, and `storage` is scoped
 * per extension. Opened after a successful archive it would read the new state
 * and render its ordinary "Press Archive…" form, which is the opposite of a
 * confirmation. So the card reports its own result, and the action extension
 * stays what it is: the entry point that needs no pinning, confirming and
 * reporting its own writes behind More actions.
 *
 * THE ADMIN'S OWN TAGS CARD DOES NOT UPDATE. Nothing here can fix that.
 * Shopify's own Tags card keeps showing what it fetched at page load
 * until the merchant reloads, whatever writes happen in between and wherever
 * they come from.
 *
 * IT IS THE TAGS CARD, and nothing else. Measured on a real store with a
 * throwaway probe extension, since removed. What repaints on action close:
 *   - Product TITLE, written with productUpdate: repaints, no reload.
 *   - Draft order NOTE, from a draft-order action: repaints, no reload.
 * What does not, in the same action, before the same shopify.close():
 *   - Tag via tagsAdd (direct API from the sandbox)
 *   - Tag via productUpdate — the exact mutation that repaints the title
 *   - Tag via the app's own backend, server-side, with the app's access token
 * Ruled out as variables: mutation choice, page type, extension api_version
 * (2025-10 behaves like 2026-07), launch path (More actions vs navigation from a
 * block), and where the write executes.
 *
 * Every write succeeded — a reload shows it every time. So the page refetches
 * on close, the refetch returns the tags, and the admin's Tags card does not
 * rerender from it. Shopify-side, unreachable from an extension. Don't spend
 * more time on it.
 *
 * NO TAG IS NAMED ON THIS CARD. Not the product's current tags — Shopify's own
 * Tags card is showing those on the same page — and not the saved ones either.
 *
 * The saved list used to be here as chips, on the argument that QuickTag has
 * removed those tags from the product and this card is the only surface left
 * that could display them. True, and it lost to a simpler reading of what the
 * card is for: a merchant looking at it is deciding whether to press a button,
 * not auditing a backup. The count is what carries that decision, and the count
 * is in the sentence. Every other QuickTag surface dropped its chip lists for
 * the same reason.
 *
 * The consequence, stated so it is a choice and not a surprise: while a product
 * is archived, the individual saved tags are not visible anywhere in the admin.
 * They are on the server, they come back on unarchive, and nothing on screen
 * spells them out.
 *
 * WHY THIS CARD POLLS:
 * Edits made anywhere else on the page — the merchant deleting a tag in the
 * Tags card and saving, or the action modal archiving the product — are never
 * pushed here. BlockExtensionApi is {auth, data, extension, i18n, intents,
 * navigation, picker, query, resourcePicker, storage}: no product-save event,
 * no host-page change event, no action-closed event, and `data` is a plain
 * object of resource IDs rather than a reactive one. Checked against both the
 * installed @shopify/ui-extensions types and the published Block Extension API
 * reference.
 *
 * No push does not mean no live updates: the card pulls instead. It re-reads on
 * an interval, so an edit made elsewhere — the Tags card, or the action
 * extension under More actions — shows up within POLL_INTERVAL_MS with no page
 * reload and nothing for the merchant to click. The interval is unconditional:
 * the sandbox cannot see whether the browser tab is visible, so a background tab
 * keeps polling. See the note on the polling effect.
 *
 * Merchants must pin this block to the product page once, in the admin, before
 * it shows up. Blocks are opt-in per page.
 */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  loadQuickTagState,
  submitQuickTag,
  type ProductTagState,
} from "./quicktag-api";

/**
 * How often the card re-reads server state. Ten seconds is short enough that an
 * edit made elsewhere on the page shows up while the merchant is still looking
 * at it, and long enough that an idle open page costs almost nothing.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * How long the success banner stays up after a write. Long enough to read one
 * sentence; short enough that it is gone before it becomes furniture the
 * merchant stops seeing.
 *
 * IT IS NOT PAUSED BY LOOKING AWAY, and cannot be — the sandbox has no
 * visibility API (see the polling effect for the long version). A merchant who
 * presses the button and switches tabs comes back to a card with no note on it.
 * The state sentence is still correct, and Shopify's Tags card is still stale
 * until they reload; only the reminder is gone.
 */
const REFRESH_NOTE_MS = 5_000;

/**
 * A write that failed, with the heading that belongs to it. The heading travels
 * with the message because one banner serves both operations, and after pressing
 * a destructive button "That didn't work" doesn't say whether anything was
 * written.
 */
type Failure = { heading: string; message: string };

export default async () => {
  render(<Extension />, document.body);
};

/** Every tag in `tags` with no case-insensitive match in `other`. */
function withoutTags(tags: string[], other: string[]): string[] {
  const known = new Set(other.map((tag) => tag.trim().toLowerCase()));
  return tags.filter((current) => !known.has(current.trim().toLowerCase()));
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

function Extension() {
  // The product currently open in the admin. Comes from the extension context,
  // so the merchant never types or picks an ID.
  const productId = shopify.data?.selected?.[0]?.id;

  const [state, setState] = useState<ProductTagState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The shop's archive tags, which is the whole of what a write from here would
  // apply — there is nothing per-product to choose. Every reply carries them.
  const [managedTags, setManagedTags] = useState<string[]>([]);

  /**
   * Which write is in flight, or null. Carries the operation rather than a flag
   * because the spinner that replaces the card's body is labelled with it — the
   * merchant just pressed a destructive button and deserves to read back which
   * one.
   */
  const [busy, setBusy] = useState<"archive" | "restore" | null>(null);
  const [writeError, setWriteError] = useState<Failure | null>(null);

  /**
   * Which write just landed, or null. Set on success and cleared by a timer —
   * see REFRESH_NOTE_MS.
   *
   * It drives a success banner that names the write and then gives the one fact
   * the card cannot show and the merchant cannot deduce: that Shopify's own Tags
   * card — wherever the merchant pinned this block relative to it — is still
   * displaying pre-write data and will keep doing so until a reload.
   */
  const [refreshNote, setRefreshNote] = useState<
    "archived" | "restored" | null
  >(null);

  // Checked by default: the safe branch. See the archived body for what
  // unchecking it does.
  const [keepNewerTags, setKeepNewerTags] = useState(true);

  /**
   * Re-reads server state.
   *
   * Failures set the banner only when there is nothing on screen yet. A poll
   * that fails against a card already showing good data must not replace it
   * with an error the merchant didn't ask for — the next tick will very likely
   * succeed.
   *
   * IT STANDS DOWN DURING A WRITE. A tick that lands mid-archive would answer
   * with pre-write state and repaint the card as though nothing had happened,
   * and the write's own reply is fresher than anything a poll can fetch.
   */
  async function reload(): Promise<void> {
    if (!productId || busy) return;

    try {
      const response = await loadQuickTagState(productId);
      setManagedTags(response.managedTags);
      if (response.state) {
        setState(response.state);
        setError(null);
      } else if (!state) {
        setError(response.error ?? null);
      }
    } catch (caught) {
      // `state` and `busy` here are the values from the render this closure was
      // built in, and reloadRef is repointed at a fresh closure after every
      // commit — so this reads current state without a second ref to keep in
      // sync.
      if (!state) {
        setError(
          caught instanceof Error
            ? caught.message
            : "QuickTag could not read this product.",
        );
      }
    }
  }

  // Kept in a ref so the polling effect can call the latest closure without
  // tearing itself down and rebuilding the interval on every render. Written in
  // an effect rather than inline: mutating a ref during render is a react-hooks
  // violation, and the poll only ever fires after a commit anyway.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });

  useEffect(() => {
    if (!productId) {
      setError("No product is in context on this page.");
      return;
    }

    let cancelled = false;
    loadQuickTagState(productId)
      .then((response) => {
        if (cancelled) return;
        setManagedTags(response.managedTags);
        if (response.state) {
          setState(response.state);
        } else {
          setError(response.error ?? "This product could not be read.");
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "QuickTag could not read this product.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [productId]);

  /**
   * The live update. See the file header for why pulling is the only option.
   *
   * THE TICK DOES NOT PAUSE ON A HIDDEN TAB, and cannot. This effect used to
   * skip ticks when `document.visibilityState === "hidden"` and re-read on
   * `visibilitychange`; neither did anything, and both have been removed.
   *
   * `document` here is not the browser's. Shopify runs extensions through
   * remote-dom, whose sandbox gets a minimal DOM polyfill — enough for Preact
   * to render into, and no more. Its `Document` class extends ParentNode →
   * Node → EventTarget and declares body, head, documentElement, createElement,
   * createTextNode, createComment, createDocumentFragment, createEvent,
   * importNode, adoptNode. No `visibilityState`, no `hidden`; the string
   * "visibility" does not appear anywhere in @remote-dom/polyfill's source.
   *
   * So the guard read `undefined === "hidden"` — false on every tick, skipping
   * nothing — and the listener registered on the inherited EventTarget without
   * error and waited for an event the sandbox has no way to receive. The card
   * has always polled straight through a hidden tab. Deleting this changed no
   * behaviour, only the description of it.
   *
   * Nothing in the extension APIs exposes tab visibility, so there is no fix to
   * write, only a cost to accept: a product page left open in a background tab
   * re-reads every POLL_INTERVAL_MS until it's closed.
   */
  useEffect(() => {
    if (!productId) return;

    const timer = setInterval(() => {
      reloadRef.current().catch(() => {
        // Swallowed on purpose: reload already decides what a failure should
        // do to what's on screen.
      });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [productId]);

  /**
   * Retires the reload note on its own.
   *
   * Keyed on the flag rather than on a timestamp, so a second write inside the
   * window tears the first timer down and starts a fresh one — the note gets its
   * full time from the write that most recently earned it, not from the first.
   */
  useEffect(() => {
    if (!refreshNote) return;

    const timer = setTimeout(() => setRefreshNote(null), REFRESH_NOTE_MS);
    return () => clearTimeout(timer);
  }, [refreshNote]);

  /**
   * Archive. Applies the shop's archive tags and saves everything the product
   * is wearing now; the server owns the order and the verification.
   *
   * The guard on `managedTags` is unreachable from the UI — the button is
   * disabled without them — and stays because this function removes tags and
   * must not run with nothing to put in their place, whatever calls it.
   */
  async function handleArchive() {
    if (!productId || !managedTags.length) return;

    setBusy("archive");
    setWriteError(null);
    setRefreshNote(null);

    try {
      const response = await submitQuickTag({
        intent: "archive",
        productId,
        appliedTags: managedTags,
      });

      setManagedTags(response.managedTags);
      // A failed call still carries fresh state when the product could be read
      // — repaint from it, so an "already archived" refusal leaves the card
      // offering Unarchive rather than a stale Archive.
      if (response.state) setState(response.state);

      if (!response.ok) {
        setWriteError({
          heading: "Couldn't archive this product's tags",
          message:
            response.error ?? "This product's tags could not be archived.",
        });
        return;
      }

      setRefreshNote("archived");
    } catch (caught) {
      setWriteError({
        heading: "Couldn't archive this product's tags",
        message:
          caught instanceof Error
            ? caught.message
            : "Something went wrong archiving this product's tags.",
      });
    } finally {
      setBusy(null);
    }
  }

  /** Unarchive. Puts the saved tags back and removes the archive tags. */
  async function handleRestore() {
    if (!productId) return;

    setBusy("restore");
    setWriteError(null);
    setRefreshNote(null);

    try {
      const response = await submitQuickTag({
        intent: "restore",
        productId,
        keepNewerTags,
      });

      setManagedTags(response.managedTags);
      if (response.state) setState(response.state);

      if (!response.ok) {
        setWriteError({
          heading: "Couldn't unarchive this product's tags",
          message:
            response.error ?? "This product's tags could not be unarchived.",
        });
        return;
      }

      setRefreshNote("restored");
      // Back to the safe branch, so the next round on this page doesn't inherit
      // a destructive choice made in the last one.
      setKeepNewerTags(true);
    } catch (caught) {
      setWriteError({
        heading: "Couldn't unarchive this product's tags",
        message:
          caught instanceof Error
            ? caught.message
            : "Something went wrong unarchiving this product's tags.",
      });
    } finally {
      setBusy(null);
    }
  }

  const loading = !state && !error;
  const archived = state?.tagState === "archived";
  const archivedOn = formatDate(state?.updatedAt ?? null);

  /*
    WHAT ARCHIVING WOULD ACTUALLY SAVE — the live tags MINUS the shop's archive
    tags, which is the server's own rule (`savedTags` in archiveProduct).

    THIS USED TO BE `state.tags.length` AND THE COUNT WAS WRONG. An archive tag
    the product already carried is excluded from the snapshot and removed on
    unarchive — see the reserved-tags rule in quicktag-archive.server.ts — so
    counting it here promised the merchant a tag back that unarchive takes off.
    On a product whose only tag was an archive tag, the card offered to save one
    tag and saved none.

    The action extension computes the same list. Keep the two in step.
  */
  const wouldSave = state ? withoutTags(state.tags, managedTags) : [];
  const busyLabel = busy === "archive" ? "Archiving…" : "Unarchiving…";

  return (
    <s-admin-block heading="QuickTag">
      <s-stack direction="block" gap="base">
        {error ? (
          <s-banner tone="critical" heading="Couldn't load this product">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        ) : null}

        {loading ? (
          <s-spinner accessibilityLabel="Loading tag state"></s-spinner>
        ) : null}

        {/*
          THE WRITE REPLACES THE BODY. While it is in flight the sentence, the
          checkbox and the button are unmounted and a labelled spinner stands in
          their place — which is also how the button cannot be pressed twice.
          When it comes back, it comes back describing the other state, and that
          change is the whole confirmation.
        */}
        {busy ? (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-spinner accessibilityLabel={busyLabel} size="base"></s-spinner>
            <s-paragraph>{busyLabel}</s-paragraph>
          </s-stack>
        ) : null}

        {state && !busy ? (
          <>
            {writeError ? (
              <s-banner tone="critical" heading={writeError.heading}>
                <s-paragraph>{writeError.message}</s-paragraph>
              </s-banner>
            ) : null}

            {/*
              ONE SENTENCE PER STATE, and it names the button. Whichever state
              the product is in, the card says what pressing the button will do
              and what it costs — not which tags QuickTag would apply, which the
              merchant chose in settings and is not being asked about here.

              AND IT IS THE RESULT TOO. Pressing the button rewrites this
              sentence into the other state's — Unarchive to Archive, and back —
              which is why nothing else on the card announces what happened. The
              action extension carries the same copy for its own confirm step;
              keep the two in step.

              THERE IS NO BADGE ABOVE THIS, and if one is ever added it must not
              read "Archived". Shopify's own product status — Active / Draft /
              Archived — renders on this same page, so a QuickTag pill saying
              "Archived" inches from that control reads as product status, which
              would mean QuickTag had unpublished the product. It never touches
              anything but tags. The pill that was here said "Tags archived" for
              that reason, and went when the date moved into this sentence: with
              "Archived on <date>" written out, the badge was saying the same
              thing a second time.

              THE DATE IS DROPPED ENTIRELY when it can't be parsed, rather than
              printed as "on Invalid Date" or as an unexplained gap.
            */}
            <s-paragraph>
              {archived
                ? state.savedTags.length > 0
                  ? `Press Unarchive to put this product's ${
                      state.savedTags.length
                    } saved tag${state.savedTags.length === 1 ? "" : "s"} back.`
                  : "Press Unarchive to remove the archive tags. There were no tags to put back."
                : wouldSave.length > 0
                  ? `Press Archive to save and remove this product's ${
                      wouldSave.length
                    } tag${wouldSave.length === 1 ? "" : "s"}. Unarchive puts ${
                      wouldSave.length === 1 ? "it" : "them"
                    } back.`
                  : "Press Archive to mark this product as archived. It has no tags to save."}
              {archived && archivedOn ? ` Archived on ${archivedOn}.` : ""}
            </s-paragraph>

            {/*
              THE ONE QUESTION LEFT, asked here because there is no dialog to
              ask it in. It only exists when there is something to choose about:
              with no newer tags both branches do the same thing, and a checkbox
              that changes nothing is worse than no checkbox.
            */}
            {archived && state.newerTags.length > 0 ? (
              <>
                <s-checkbox
                  label={`Keep the ${state.newerTags.length} tag${
                    state.newerTags.length === 1 ? "" : "s"
                  } added since archiving`}
                  name="keepNewerTags"
                  checked={keepNewerTags}
                  details={state.newerTags.join(", ")}
                  onChange={(event: Event) =>
                    setKeepNewerTags((event.target as HTMLInputElement).checked)
                  }
                />

                {!keepNewerTags ? (
                  <s-banner tone="critical" heading="This deletes tags">
                    <s-paragraph>
                      {`Unchecking this permanently deletes the ${
                        state.newerTags.length
                      } tag${
                        state.newerTags.length === 1 ? "" : "s"
                      } added since archiving.`}{" "}
                      Tags added by other apps go too.
                    </s-paragraph>
                  </s-banner>
                ) : null}
              </>
            ) : null}

            {/*
              A shop with no archive tags set. Archiving anyway would remove the
              product's tags and leave nothing marking it as archived, which is
              nobody's intent — so the button is disabled and this says where to
              fix it, rather than letting the press through to an error.
            */}
            {!archived && managedTags.length === 0 ? (
              <s-banner tone="warning" heading="No archive tags are set">
                <s-paragraph>
                  Set at least one archive tag in QuickTag&apos;s settings
                  first.
                </s-paragraph>
              </s-banner>
            ) : null}

            {/*
              One button, and it is never "Archive" on an archived product —
              re-archiving would overwrite the saved snapshot with the archived
              state of the product, which is to say destroy it. The server
              refuses it too; this is just not offering it.
            */}
            {archived ? (
              <s-button
                variant="primary"
                {...(keepNewerTags ? {} : { tone: "critical" as const })}
                onClick={handleRestore}
              >
                Unarchive
              </s-button>
            ) : (
              <s-button
                variant="primary"
                onClick={handleArchive}
                {...(managedTags.length === 0 ? { disabled: true } : {})}
              >
                Archive
              </s-button>
            )}

            {/*
              A SUCCESS BANNER THAT CLOSES ITSELF. Green because the merchant
              pressed a destructive-sounding button and the first thing they need
              is that it worked; gone on its own because nothing here is waiting
              on them, and a banner that has to be dismissed becomes furniture
              on a card they will see on every product.

              NOT DISMISSIBLE, deliberately. There is no ✕ because there is
              nothing to decide — REFRESH_NOTE_MS retires it either way, and a
              close button on a self-closing banner is a control that races a
              timer.

              LAST ON THE CARD, not first, which is where a banner normally
              goes. Appearing and vanishing at the top would shove the sentence
              and the button down and back up on every write, moving the button
              out from under the cursor. At the end it only ever grows the card
              downward.

              THE HEADING NAMES THE OBJECT, NOT JUST THE VERB: "Tags archived",
              never a bare "Archived". This card renders on the same page as
              Shopify's Active / Draft / Archived control, so a green banner
              reading "Archived" is read as product status — which would mean
              QuickTag had unpublished the product. It never touches anything
              but tags. This is the same reason the badge above was killed (see
              the state sentence), and it applies with more force here: a badge
              is decoration, a success banner is the app telling the merchant
              what it just did.

              It stays in the completed form of the button that was pressed —
              Archive → "Tags archived" — so the two read as one action rather
              than two vocabularies. That matters because the rest of the card
              confirms the write only by changing tense: both states open with
              "Press". The action extension carries the identical strings.

              THE BODY SAYS NO WHERE. Not "below", not "above": a merchant pins
              this block, and where they pin it decides whether Shopify's Tags
              card ends up under it or over it. Naming a direction is wrong for
              half of them, and the card is identifiable by name alone.

              SHOPIFY IS NAMED, and the refresh is stated as a fact rather than
              asked for. Coming from QuickTag's own card, "Refresh the page to
              update the Tags card" reads as QuickTag apologising for a bug of
              its own. The lag is Shopify's — that card holds its page-load data
              through any write, whatever makes it, as the file header records.
            */}
            {refreshNote ? (
              <s-banner
                tone="success"
                heading={
                  refreshNote === "archived" ? "Tags archived" : "Tags unarchived"
                }
              >
                <s-paragraph>
                  Shopify&apos;s Tags card updates on your next page refresh.
                </s-paragraph>
              </s-banner>
            ) : null}
          </>
        ) : null}
      </s-stack>
    </s-admin-block>
  );
}
