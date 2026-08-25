/**
 * QuickTag — product details action extension. Archive and Restore.
 *
 * WHERE THIS RUNS: not on your machine. The Shopify CLI compiles this file to a
 * JS bundle, uploads it to Shopify, and Shopify executes it in a sandboxed
 * worker that it hosts, inside the merchant's admin page. The UI you return is
 * not DOM in the admin document — it is a component tree that Shopify
 * serialises across the sandbox boundary and renders itself, which is why you
 * use `s-*` Polaris web components instead of `<div>`.
 *
 * WHAT IT DOES NOT DO: decide anything about tags. Every archive and restore
 * sequence lives on the app server in app/quicktag-archive.server.ts, behind
 * /api/quicktag, and the block extension calls the same endpoint. This file
 * collects the merchant's choices and renders the result. The rules about what
 * order tags are written in, what gets verified, and when a backup may be
 * deleted are not repeated here, because repeating them is how two extensions
 * drift apart.
 *
 * WHY THE WRITES LIVE BEHIND A MODAL. Both of them need to be confirmed and
 * then reported, and a dialog is the only place that can happen — the block
 * extension's buttons hand off here rather than writing, because a block
 * CANNOT raise a dialog at all. `s-modal` is allowed on one admin target and it
 * isn't a block: the per-target allowlists in
 * @shopify/ui-extensions/build/ts/surfaces/admin/targets/ are the record, and
 * only admin.app.home.render imports components/Modal.d.ts. A block that wrote
 * inline was built and removed; it could only report a result as a banner that
 * has to be dismissed by hand or sits there going stale.
 *
 * So: the card describes, this file confirms, decides nothing, and reports. One
 * backend sequence, two front doors, and this is the door that needs no setup —
 * see the note at the end.
 *
 * `shopify.close()` DOES NOT REFRESH THE PRODUCT PAGE — and that is specific to
 * this page, not how actions behave generally.
 *
 * Measured, not assumed. Shopify's docs say a page picks up an action's changes
 * once it closes. This action writes tags, closes, and the admin's own Tags card
 * keeps its page-load data until a full reload — same result whether it's opened
 * from More actions or launched from the block extension via
 * `shopify.navigation.navigate`. That much is confirmed on a real store.
 *
 * WHY, established by measurement on a real store with a throwaway probe
 * extension, since removed. Repaints on close, no reload: the product TITLE
 * written with productUpdate, and a draft order NOTE from a draft-order action.
 * Does NOT repaint, in the same action, before the same close: a tag written
 * with tagsAdd, a tag written with productUpdate (the very mutation that
 * repaints the title), and a tag written server-side through the app's own
 * backend. Also ruled out: extension api_version (2025-10 matches 2026-07) and
 * launch path.
 *
 * Every write landed — a reload shows the change every time. So the page
 * refetches on close, the refetch returns the tags, and the admin's Tags card
 * doesn't rerender from it. Shopify-side and unreachable from an extension.
 *
 * THIS MATTERS MORE IN v1.1 THAN IT DID IN v1.0. Archiving REMOVES tags. A
 * merchant who archives and sees the native Tags card still listing all of them
 * has every reason to think the archive failed and to try again. So this modal
 * does not close itself on success: it stays open, states exactly what changed,
 * and says a refresh is needed to see it on the page.
 *
 * AND THERE IS NO RELOAD BUTTON, because a reload cannot be triggered from
 * here at all. Four routes were tried on a real store, in this order:
 *
 *   1. Script it. Impossible. ActionExtensionApi is {extension, auth, i18n,
 *      intents, storage, query, resourcePicker, picker, close, data} — no
 *      `navigation` — and `window.location` is the sandbox's own document, not
 *      the admin page. (`navigation` exists only on block targets, and its own
 *      docs scope it to opening an action on the same resource page.)
 *   2. s-button, href = absolute https://admin.shopify.com/store/<handle>/
 *      products/<id>, target="_top". Navigates, but the host treats an absolute
 *      URL as external and opens a NEW TAB. Not a reload.
 *   3. s-button, href = shopify:admin/products/<id> — Shopify's documented
 *      custom protocol for admin-rooted URLs. Nothing happens, and hovering
 *      shows no URL at all: s-button renders no anchor for a protocol it can't
 *      resolve. The protocol appears only ever to be documented on links.
 *   4. s-link, same shopify:admin URL. This one genuinely resolves — hovering
 *      shows the real admin URL — and clicking genuinely attempts to navigate.
 *      The admin's own router then rejects it:
 *
 *          "A router only supports one blocker at a time"
 *
 *      A product details page registers a navigation blocker for its unsaved-
 *      changes guard, and the open action modal registers another. Two blockers
 *      and the router throws, so the navigation is aborted. Nothing in an
 *      extension can unregister the host page's blocker.
 *
 * So the modal asks the merchant to refresh, which is all it can honestly do.
 * Don't re-add a Reload control without new evidence that (4) has changed.
 *
 * WHY THIS EXTENSION STILL EXISTS ALONGSIDE THE BLOCK: it's the entry point
 * that needs no setup. Block extensions have to be pinned to the product page
 * by the merchant before they appear; this shows up in More actions immediately
 * after install.
 */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import {
  loadQuickTagState,
  submitQuickTag,
  type ProductTagState,
} from "./quicktag-api";

export default async () => {
  render(<Extension />, document.body);
};

/**
 * Which write succeeded, so the modal can name it and stop. No payload: the
 * success banners state the outcome and nothing about the tags themselves —
 * what changed is on the product, and the merchant is being sent to look at it.
 */
type Outcome = { kind: "archived" } | { kind: "restored" };

/**
 * A failure, with the heading that belongs to it.
 *
 * THE HEADING TRAVELS WITH THE MESSAGE because one banner serves three
 * different failures — an empty list, a failed archive and a failed restore. It
 * used to head all of them with "That didn't work", which
 * is the same sentence a merchant could write themselves from looking at the
 * screen. Worse on the two that matter: after pressing a destructive button,
 * "That didn't work" doesn't say whether the archive failed, the connection
 * failed, or the tag was rejected — so it doesn't say whether anything was
 * written.
 */
type Failure = { heading: string; message: string };

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
  const [managedTags, setManagedTags] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Checked by default: the safe branch. See the restore form for what
  // unchecking it does.
  const [keepNewerTags, setKeepNewerTags] = useState(true);

  /**
   * Which write is in flight, or null. Carries the operation and not just a
   * flag because the busy state replaces the modal body, and a bare spinner
   * over an empty modal doesn't say what is being waited on — the merchant just
   * pressed a destructive button and deserves to read it back.
   *
   * Truthiness is what every consumer actually tests, so the branches below
   * read the same as they did when this was a boolean.
   */
  const [busy, setBusy] = useState<"archive" | "restore" | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!productId) {
      setLoadError("No product is in context on this page.");
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
          setLoadError(response.error ?? "This product could not be read.");
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "QuickTag could not load this product.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [productId]);

  async function handleArchive() {
    if (!tagsToApply.length) {
      setError({
        heading: "No archive tags are set",
        message:
          "Archiving with none would remove this product's tags and leave nothing marking it.",
      });
      return;
    }

    setBusy("archive");
    setError(null);

    try {
      const response = await submitQuickTag({
        intent: "archive",
        productId: productId!,
        appliedTags: tagsToApply,
      });

      // A failed call still carries fresh state when the product could be read
      // — repaint from it, so an "already archived" refusal turns the modal
      // into the restore form instead of leaving a stale Archive button.
      if (response.state) setState(response.state);

      if (!response.ok) {
        setError({
          heading: "Couldn't archive this product's tags",
          message:
            response.error ?? "This product's tags could not be archived.",
        });
        return;
      }

      setOutcome({ kind: "archived" });
    } catch (caught) {
      setError({
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

  async function handleRestore() {
    setBusy("restore");
    setError(null);

    try {
      const response = await submitQuickTag({
        intent: "restore",
        productId: productId!,
        keepNewerTags,
      });

      if (response.state) setState(response.state);

      if (!response.ok) {
        setError({
          heading: "Couldn't unarchive this product's tags",
          message:
            response.error ?? "This product's tags could not be unarchived.",
        });
        return;
      }

      setOutcome({ kind: "restored" });
    } catch (caught) {
      setError({
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

  const loading = !state && !loadError;

  // The shop's archive tags, which is the whole of what this modal would apply
  // — there is nothing per-product to edit here. Empty until the fetch lands,
  // and empty for a shop that has set no defaults.
  const tagsToApply = managedTags ?? [];

  // What would be saved and removed. Mirrors the server's rule: an applied tag
  // is never part of its own snapshot.
  const wouldSave = state ? withoutTags(state.tags, tagsToApply) : [];

  const archivedOn = formatDate(state?.updatedAt ?? null);

  /*
    THE WRITE REPLACES THE BODY, it does not dim it. While a write is in flight
    the form is unmounted and a spinner stands in its place until the success
    banner arrives.

    Dimming the form in place was the other candidate, and `s-admin-action`'s
    own `loading` prop looks like the way to get it — Shopify documents it as
    "an inert state that prevents user interaction". What is NOT documented is
    whether that inertness reaches the footer, and if it does it would freeze
    the primary button's own spinner. That would leave a greyed form and no
    motion anywhere: the exact reading of "nothing is happening" this change
    exists to prevent. A spinner we render ourselves cannot be switched off by
    the host.

    `loading` therefore stays scoped to the initial fetch, where there is no
    content to dim and nothing of ours to freeze.

    THE SPINNER IS LABELLED with the operation, which is why `busy` carries it.
    Archive is destructive; a merchant who just pressed it and is watching an
    unlabelled spinner has no confirmation they pressed the right button.
  */
  const busyLabel = busy === "archive" ? "Archiving…" : "Unarchiving…";

  /*
    THE HEADING NAMES THE ACTION, not the app. It used to read "QuickTag",
    which tells the merchant which app opened the modal — the one thing they
    already know, having just clicked it — and spends the most prominent line
    in the dialog doing it.

    IT IS DERIVED FROM THE FLOW, NOT FROM `state`, and the difference only shows
    up at the end. A successful archive flips `state.tagState` to "archived", so
    a heading read straight off state would change to "Unarchive tags" at the
    exact moment the success banner says "Archived" — telling the merchant they
    are about to unarchive the thing they just archived. Keying off `outcome`
    first holds the heading still: it names the flow the merchant is in for as
    long as they are in it.

    Null while the product is still loading. Neither verb is honest before the
    fetch says which one applies, and guessing "Archive tags" would visibly
    flip to "Unarchive tags" on an already-archived product.
  */
  const flow: "archive" | "restore" | null = outcome
    ? outcome.kind === "restored"
      ? "restore"
      : "archive"
    : state
      ? state.tagState === "archived"
        ? "restore"
        : "archive"
      : null;

  const heading =
    flow === "restore"
      ? "Unarchive tags"
      : flow === "archive"
        ? "Archive tags"
        : "QuickTag";

  return (
    <s-admin-action heading={heading} {...(loading ? { loading: true } : {})}>
      {busy ? (
        <s-stack
          direction="block"
          gap="base"
          alignItems="center"
          justifyContent="center"
        >
          <s-spinner accessibilityLabel={busyLabel} size="base"></s-spinner>
          <s-paragraph>{busyLabel}</s-paragraph>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="base">
          {loadError ? (
            <s-banner tone="critical" heading="Couldn't load this product">
              <s-paragraph>{loadError}</s-paragraph>
            </s-banner>
          ) : null}

          {error ? (
            <s-banner tone="critical" heading={error.heading}>
              <s-paragraph>{error.message}</s-paragraph>
            </s-banner>
          ) : null}

          {/*
          SUCCESS. The modal stays open and confirms the write, because the
          admin's own Tags card does not — see the file header. On archive
          that card still lists every tag QuickTag just removed, which without
          this banner reads as "nothing happened".
        */}
          {outcome?.kind === "archived" ? (
            <s-banner tone="success" heading="Tags archived">
              {/*
                SHOPIFY IS NAMED, and the refresh is stated as a fact rather
                than asked for. This read "Refresh the page to update the Tags
                card", which coming from QuickTag's own success banner reads as
                QuickTag apologising for a bug of its own. The lag is Shopify's
                — the admin's Tags card holds its page-load data through any
                write, whatever makes it, as the file header records.

                NO DIRECTION IS NAMED. This said "the Tags card below", which
                is not reliably true even from a modal, and is wrong outright on
                the block card, where the merchant's own pin placement decides
                whether Shopify's Tags card sits above or under it. Both
                surfaces carry this sentence; it has to be true on both.
              */}
              <s-paragraph color="subdued">
                Shopify&apos;s Tags card updates on your next page refresh.
              </s-paragraph>
            </s-banner>
          ) : null}

          {outcome?.kind === "restored" ? (
            <s-banner tone="success" heading="Tags unarchived">
              {/* Same reasoning as the archive banner above. */}
              <s-paragraph color="subdued">
                Shopify&apos;s Tags card updates on your next page refresh.
              </s-paragraph>
            </s-banner>
          ) : null}

          {/*
          ARCHIVE FORM. Only ever rendered for an ACTIVE product — an archived
          one falls through to the restore form below, so re-archiving is not
          something this modal can offer.
        */}
          {!outcome && state?.tagState === "active" ? (
            tagsToApply.length === 0 ? (
              /*
                A shop with no archive tags set. Archiving anyway would remove
                the product's tags and leave nothing marking it as archived,
                which is nobody's intent — so the button is disabled and this
                says where to fix it, rather than letting the press through to
                an error.
              */
              <s-banner tone="warning" heading="No archive tags are set">
                <s-paragraph>
                  Set at least one archive tag in QuickTag&apos;s settings
                  first. Archiving with none would remove this product&apos;s
                  tags and leave nothing marking it.
                </s-paragraph>
              </s-banner>
            ) : (
              /*
                ONE SENTENCE, AND IT NAMES NO TAGS. This screen has been a
                to-do list of everything QuickTag knows: chips for the tags
                going on, chips for the tags coming off, then the same two lists
                spelled out as prose. All of it was true and none of it was the
                question the merchant is answering, which is whether to press
                the button.

                WHICH TAGS GO ON IS NOT ASKED HERE ANY MORE, so it isn't
                answered here either — the merchant set those in QuickTag's
                settings and can read them back there. What they can't get
                anywhere else is what this click costs: the tags currently on
                the product come off. So that is counted, and the way back is
                named in the same breath.

                The count is not a list. There can be dozens, and they are all
                already on screen in the admin's own Tags card on the page
                behind this modal.
              */
              <s-paragraph>
                {wouldSave.length > 0
                  ? `Press Archive to save and remove this product's ${
                      wouldSave.length
                    } tag${wouldSave.length === 1 ? "" : "s"}. Unarchive puts ${
                      wouldSave.length === 1 ? "it" : "them"
                    } back.`
                  : "Press Archive to mark this product as archived. It has no tags to save."}
              </s-paragraph>
            )
          ) : null}

          {/*
          RESTORE FORM.
        */}
          {!outcome && state?.tagState === "archived" ? (
            <>
              {/*
                THE ACTION FIRST, THE DATE AFTER — same shape as the archive
                screen. This was two paragraphs, and the first one was the
                archive date: a fact about the past leading a screen whose whole
                job is one decision about the present. The date is worth keeping
                and worth being second.

                It is dropped entirely when it can't be parsed, rather than
                printed as "on Invalid Date" or as an unexplained gap.
              */}
              <s-paragraph>
                {state.savedTags.length > 0
                  ? `Press Unarchive to put this product's ${
                      state.savedTags.length
                    } saved tag${state.savedTags.length === 1 ? "" : "s"} back.`
                  : "Press Unarchive to remove the archive tags. There were no tags to put back."}
                {archivedOn ? ` Archived on ${archivedOn}.` : ""}
              </s-paragraph>

              {/*
              The choice only exists when there is something to choose about.
              With no newer tags both branches do the same thing, and a
              checkbox that changes nothing is worse than no checkbox.
            */}
              {state.newerTags.length > 0 ? (
                <>
                  <s-checkbox
                    label={`Keep the ${state.newerTags.length} tag${
                      state.newerTags.length === 1 ? "" : "s"
                    } added since archiving`}
                    name="keepNewerTags"
                    checked={keepNewerTags}
                    details={state.newerTags.join(", ")}
                    onChange={(event: Event) =>
                      setKeepNewerTags(
                        (event.target as HTMLInputElement).checked,
                      )
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
            </>
          ) : null}
        </s-stack>
      )}

      {/*
        WHY "Done" SITS IN secondary-actions AND primary-action IS EMPTY on the
        terminal states. s-admin-action renders its own Cancel into
        secondary-actions whenever that slot is empty — the string appears
        nowhere in this file or in the built bundle, so it is the host's, not
        ours. After a write, "Cancel" reads as a way to undo it, which it is
        not; both merely close.

        The slot cannot be emptied, only occupied. An empty s-box was tried and
        is worse: it suppresses the Cancel label but still renders the slot's
        button chrome, leaving a blank ghost button. So the slot gets the real
        button, and the primary slot is left out instead.

        Before a write, the host's own Cancel is exactly right and the slot is
        left alone: nothing has happened yet, and Archive in particular is
        destructive enough to deserve a visible way out.

        DURING a write it is exactly wrong, which is the `busy` branch below.
        The host's Cancel stays clickable while the primary button spins, and
        clicking it closes the modal — but it cannot cancel anything. The
        request is already with the server, which finishes the write and answers
        into a modal that no longer exists. The merchant sees no confirmation,
        the admin's Tags card still shows the old tags (file header explains
        why), and the honest conclusion from that screen is that nothing
        happened. It did. On archive, their tags were just removed.

        The slot can't be emptied and the host's button can't be disabled, so
        the same occupy-the-slot trick applies: our own Cancel, disabled, for
        exactly as long as the write is in flight.

        BOTH OCCUPANTS ARE DECIDED IN ONE CHAIN so two can never hold the slot
        at once. `setOutcome` and `setBusy(false)` run in the same continuation
        and Preact batches them, but this doesn't have to be true for the modal
        to look right — a Done button beside a dead Cancel is not a state worth
        making a scheduler guarantee load-bearing for.
      */}
      {outcome || loadError ? (
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>
          Done
        </s-button>
      ) : busy ? (
        <s-button slot="secondary-actions" disabled>
          Cancel
        </s-button>
      ) : null}

      {outcome || loadError ? null : state?.tagState === "archived" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          {...(keepNewerTags ? {} : { tone: "critical" as const })}
          onClick={handleRestore}
          {...(busy ? { loading: true } : {})}
        >
          Unarchive
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleArchive}
          {...(busy ? { loading: true } : {})}
          {...(loading || !tagsToApply.length ? { disabled: true } : {})}
        >
          Archive
        </s-button>
      )}
    </s-admin-action>
  );
}
