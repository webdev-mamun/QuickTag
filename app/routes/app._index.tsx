/**
 * QuickTag — Settings screen.
 *
 * WHERE THIS RUNS: two places, and the split matters.
 *
 *   `loader` / `action`  -> your local Node server. They hold the app's access
 *                           token and talk to the Admin API over the tunnel
 *                           that `shopify app dev` opens.
 *   `Settings()`         -> the merchant's browser, inside an <iframe> that the
 *                           Shopify admin embeds. It renders Polaris web
 *                           components (`s-*`), which App Bridge styles to
 *                           match the surrounding admin chrome.
 *
 * This screen is the ONLY place `managedTags` are edited. They are the shop-wide
 * DEFAULTS: the Archive modal pre-fills them, and a merchant who edits the list
 * there is choosing tags for that one product. Those overrides are written to
 * the product's own backup as `appliedTags` and never come back here.
 *
 * WHY A CHIP EDITOR RATHER THAN A COMMA-SEPARATED FIELD. Shopify splits tag
 * input on commas, so a single field would have to either reject the comma —
 * making multiple tags impossible — or accept it and hope the split matches
 * what QuickTag recorded. One tag per entry removes the ambiguity: what the
 * merchant sees as a chip is exactly one tag on the product. It also matches
 * the affordance they already know from the admin's own Tags card.
 */
import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { WhatArchivingDoes } from "../quicktag-copy";
import {
  DEFAULT_MANAGED_TAGS,
  MAX_MANAGED_TAGS,
  readQuickTagConfig,
  validateTags,
  writeManagedTags,
} from "../quicktag.server";

/**
 * Mirrors `validateTag` in quicktag.server.ts.
 *
 * IT CANNOT BE IMPORTED. This runs in the merchant's browser, and React Router
 * strips `*.server` modules out of the client bundle — importing the real one
 * for use in the component fails the build with "Server-only module referenced
 * by client", which is exactly the guardrail working. The server validates the
 * whole list again in `action` and remains the authority; this copy exists so
 * the merchant sees a bad tag before spending a round trip.
 *
 * The extensions carry their own copy for the same reason — see
 * extensions/*\/src/quicktag-api.ts.
 */
function validateTagInput(value: string): { tag: string } | { error: string } {
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { managedTags } = await readQuickTagConfig(admin);

  return {
    managedTags: managedTags ?? [],
    defaultManagedTags: DEFAULT_MANAGED_TAGS,
    maxManagedTags: MAX_MANAGED_TAGS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  // Sent as a JSON array rather than repeated form fields: a tag may legally
  // contain almost anything, and JSON is the one encoding where that can't be
  // confused with a delimiter.
  let submitted: unknown;
  try {
    submitted = JSON.parse(String(formData.get("managedTags") ?? "[]"));
  } catch {
    return { ok: false as const, error: "The tag list could not be read." };
  }

  if (!Array.isArray(submitted)) {
    return { ok: false as const, error: "The tag list could not be read." };
  }

  // Same validator the archive path uses, so a list that would be rejected on a
  // product is rejected here too.
  const validated = validateTags(
    submitted.filter((tag): tag is string => typeof tag === "string"),
  );
  if ("error" in validated) {
    return { ok: false as const, error: validated.error };
  }

  // Re-read to get this shop's AppInstallation id — it's the metafield owner
  // and it is different on every store, so it can't be hardcoded.
  const { appInstallationId } = await readQuickTagConfig(admin);
  const errors = await writeManagedTags(
    admin,
    appInstallationId,
    validated.tags,
  );

  if (errors.length) {
    return { ok: false as const, error: errors.join(" ") };
  }
  return { ok: true as const, managedTags: validated.tags };
};

export default function Settings() {
  const { managedTags, defaultManagedTags, maxManagedTags } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [tags, setTags] = useState<string[]>(managedTags);
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState("");

  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.ok) {
      shopify.toast.show("Archive tags saved");
    } else {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  /**
   * Commits the drafted tag. Called by Enter, by blur, and by Save.
   *
   * WIRED TO BLUR, matching the admin's own Tags field. It deliberately was
   * not, on the grounds that removing a chip blurs this field — so a merchant
   * who had typed something and then clicked a chip's ✕ got TWO changes from
   * one click. That is now the accepted behaviour, because it is also the
   * literal reading of what they did, and it is what the field they learned
   * this pattern from does. What is NOT accepted is the bug underneath it: see
   * the functional update below.
   *
   * BLUR NEVER RAISES AN ERROR ON AN EMPTY FIELD. `validateTagInput("")`
   * answers "Enter a tag." — correct for a merchant who pressed Enter on
   * nothing, wrong for one who clicked into the field and back out. The caller
   * guards on a non-empty draft; this function still answers honestly for
   * everyone else.
   */
  function addTag() {
    const validated = validateTagInput(draft);
    if ("error" in validated) {
      setInputError(validated.error);
      return;
    }

    // Case-insensitive, matching Shopify's own dedupe: adding "Archive" to a
    // list holding "archive" would promise two tags and deliver one.
    const exists = tags.some(
      (tag) => tag.toLowerCase() === validated.tag.toLowerCase(),
    );
    if (exists) {
      setInputError("That tag is already in the list.");
      return;
    }

    if (tags.length >= maxManagedTags) {
      setInputError(`Use at most ${maxManagedTags} tags.`);
      return;
    }

    /*
      FUNCTIONAL UPDATE, and this is the one that makes blur-commit safe.

      Clicking a chip's ✕ with text in the field fires blur and then click, and
      both handlers close over `tags` from the SAME render — blur's setState has
      not committed yet when the click runs. Written as `setTags([...tags, x])`
      and `setTags(tags.filter(...))`, the second call overwrites the first and
      the typed tag vanishes: the merchant sees the chip go and their tag never
      arrive. Queued as updaters they compose, and both changes land.
    */
    setTags((current) => [...current, validated.tag]);
    setDraft("");
    setInputError("");
  }

  function removeTag(tag: string) {
    // Functional for the same reason addTag is — this is the click half of that
    // pair.
    setTags((current) => current.filter((existing) => existing !== tag));
    setInputError("");
  }

  /**
   * ENTER COMMITS THE TAG, wired through a native listener rather than a prop.
   *
   * `s-text-field` types only onInput/onChange/onFocus/onBlur, and this build of
   * Polaris ships no `s-form`, so neither a keydown prop nor form submission is
   * available. A ref to the custom element is, and the element is real DOM, so
   * the native event works. `preventDefault` and `stopPropagation` keep Enter
   * from reaching any surrounding submit behaviour — the same guard the Archive
   * modal needs, where a stray Enter would otherwise trigger Archive itself.
   *
   * addTag is read through a ref because the listener is bound once, and the
   * closure it would otherwise capture goes stale the moment `draft` changes.
   */
  const fieldRef = useRef<HTMLElementTagNameMap["s-text-field"]>(null);
  const addTagRef = useRef(addTag);
  useEffect(() => {
    addTagRef.current = addTag;
  });

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      addTagRef.current();
    };

    field.addEventListener("keydown", onKeyDown);
    return () => field.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Exactly the list Save would send: the chips, plus an uncommitted draft if
   * that draft is one Save would sweep up.
   *
   * COMPUTED IN RENDER, not inside `save`, because two things need it and they
   * must not disagree. `save` sends it; the enabled/disabled check below asks
   * whether it differs from what the shop already has. Deriving that answer
   * from a separate copy of these rules is how a Save button ends up greyed out
   * with a typed tag sitting in the field.
   */
  const pending = validateTagInput(draft);
  const nextTags =
    "tag" in pending &&
    !tags.some((tag) => tag.toLowerCase() === pending.tag.toLowerCase()) &&
    tags.length < maxManagedTags
      ? [...tags, pending.tag]
      : tags;

  /**
   * Whether Save would change anything.
   *
   * `managedTags` is the loader's value — what the shop has stored — and React
   * Router revalidates it once the action settles, so a successful save flips
   * this back to false on its own with nothing to reset by hand. A FAILED save
   * revalidates to the same unchanged list and stays dirty, which is what lets
   * the merchant press Save again.
   *
   * Compared by index rather than as a set: it also catches a reorder, which
   * this editor can't produce today but would silently no-op if it could.
   * Casing is not normalised here because it never drifts — the client trims
   * and dedupes case-insensitively before a chip is ever added, matching what
   * validateTags does on the server, so a round trip returns the same strings.
   */
  const isDirty =
    nextTags.length !== managedTags.length ||
    nextTags.some((tag, index) => tag !== managedTags[index]);

  const save = () => {
    // Commit whatever is still in the field first. A merchant who types a tag
    // and clicks Save without pressing Enter means to save it, and silently
    // dropping it would be the worst possible reading of that.
    if (nextTags !== tags) {
      setTags(nextTags);
      setDraft("");
    }

    fetcher.submit(
      { managedTags: JSON.stringify(nextTags) },
      { method: "POST" },
    );
  };

  const saveError = fetcher.data && !fetcher.data.ok ? fetcher.data.error : "";

  return (
    <s-page heading="QuickTag settings">
      {/*
        SAVE IS DISABLED FOR TWO SEPARATE REASONS, and they are not the same
        one. An empty list is invalid — the server rejects it, and archiving
        with no tag would strip a product and leave nothing marking it. An
        unchanged list is merely pointless: pressing Save would spend a round
        trip and an Admin API call to write back the bytes already stored, and
        the toast would claim something was saved when nothing was.

        Only the first was checked before, so the button sat enabled from page
        load with nothing to send.

        `isSaving` is not in here: `loading` already disables the button (per
        Polaris), and stating it twice invites the two conditions to drift.
      */}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(isSaving ? { loading: true } : {})}
        {...(nextTags.length === 0 || !isDirty ? { disabled: true } : {})}
      >
        Save
      </s-button>

      {/*
        NO SECTION HEADING AND NO PROSE. It carried "Default tags", a sentence
        describing the field, and a note denying that QuickTag touches product
        status.

        THE HEADING'S NAME MOVED INTO THE FIELD LABEL rather than being
        dropped, so the card is still named once, by the control it names, and
        not twice.

        THE LABEL IS "ARCHIVE TAGS", and was "Default tags". Both are accurate —
        these are the shop-wide defaults — but "default" answers a question no
        merchant is asking at this field, and it broke the trail: every surface
        that sends them here calls them archive tags ("Set at least one archive
        tag in QuickTag's settings"), and a merchant arriving from that banner
        has to recognise the field by the name they were given.

        THE INTERNAL NAMES DO NOT FOLLOW. `managedTags`, `DEFAULT_MANAGED_TAGS`
        and the `$app.config` blob keep their names: those describe what the
        value IS to the app — shop-level config, as against a product's own
        `appliedTags` — and that distinction is load-bearing in
        quicktag-archive.server.ts. Only the merchant's word for it changed.

        THE STATUS NOTE MOVED TO THE ASIDE, one column over, under "What
        archiving does" — the panel that exists to explain what this app does,
        on this page and on Archived products both. It was on the card only
        because the sentence that caused the confusion was on the card too.
      */}
      <s-section>
        {/*
          ONE STACK AROUND EVERYTHING. `s-section` does not space its own
          children, so laying these out as siblings left the chip row touching
          the paragraph under it. Every gap in this card comes from here.
        */}
        <s-stack direction="block" gap="base">
          {/*
            SHAPED AFTER THE ADMIN'S OWN TAGS CARD: one full-width field, chips
            underneath, no Add button, and NO PLACEHOLDER. A placeholder here
            would have to be a tag name, and a greyed-out tag name in an empty
            field reads as a value the field is holding — worse when that name
            is one the merchant just removed from the list below.
          */}
          <s-text-field
            ref={fieldRef}
            label="Archive tags"
            name="tag"
            value={draft}
            details="Press Enter to add a tag."
            {...(inputError ? { error: inputError } : {})}
            onInput={(event: Event) => {
              setDraft((event.target as HTMLInputElement).value);
              if (inputError) setInputError("");
            }}
            /*
              CLICKING AWAY COMMITS THE TAG, so Enter is the shortcut and not
              the requirement. `s-text-field` types onBlur as a prop, so unlike
              the Enter handler this needs no ref: the prop is re-read every
              render and closes over the current draft by itself.

              THE EMPTY GUARD IS THE WHOLE SUBTLETY. Without it, clicking into
              the field and straight back out — or tabbing through the card —
              runs addTag on "" and answers "Enter a tag." on a field the
              merchant never typed in. An empty field has nothing to commit and
              nothing to complain about.
            */
            onBlur={() => {
              if (draft.trim()) addTag();
            }}
          />

          {tags.length > 0 ? (
            <s-stack direction="inline" gap="small-200">
              {tags.map((tag) => (
                <s-clickable-chip
                  key={tag}
                  removable
                  accessibilityLabel={`Remove ${tag}`}
                  onRemove={() => removeTag(tag)}
                >
                  {tag}
                </s-clickable-chip>
              ))}
            </s-stack>
          ) : (
            /*
              An empty list is a save-blocking state, not a fallback. Archiving
              with no tag would strip a product's tags and leave nothing marking
              it — so Save is disabled here rather than silently substituting
              the documented default. See the Save button for the other reason
              it disables.

              THE COPY STATES THE SITUATION, IT DOESN'T ISSUE AN ORDER. "Add at
              least one tag" sat directly beside a Save button that is disabled
              in exactly this state — an instruction next to a control that
              refuses to carry it out. The list being empty is the fact; what
              QuickTag falls back to meanwhile is the reassurance. Neither needs
              to be phrased as a command.
            */
            <s-banner tone="warning">
              <s-paragraph>
                No tags set. Archiving uses “
                {defaultManagedTags.join("”, “")}”.
              </s-paragraph>
            </s-banner>
          )}

          {/*
            THE ONE PIECE OF PROSE THIS CARD KEEPS, and it is here rather than
            in the aside because it is a constraint on what the merchant is
            typing into the field above it — not an explanation of what the app
            does. The card was stripped of prose that merely described the
            field; this is the exception, and the test it passes is that a
            merchant who never reads it can pick a tag they will regret.

            WHAT IT IS SAYING. An archive tag a product ALREADY carries is
            excluded from the snapshot and removed on unarchive — the reserved-
            tags rule in quicktag-archive.server.ts. So a tag doing double duty
            as a real product tag is silently stripped from products that had
            it. Nothing else on any screen can warn them: by the time it
            matters, the tag is already gone and there is no record it existed.

            IT NAMES THE CONSEQUENCE BEFORE THE RULE. "These tags are reserved
            by QuickTag" is the accurate summary and means nothing to a merchant
            who has not read the source. What a tag being reserved COSTS them is
            the part they can act on while they are still choosing it.
          */}
          <s-paragraph color="subdued">
            QuickTag removes these tags when you unarchive. Don&apos;t reuse a
            tag you need for something else — if a product already carries one,
            unarchiving takes it off that product too.
          </s-paragraph>

          {saveError ? (
            <s-banner tone="critical" heading="Couldn't save your archive tags">
              <s-paragraph>{saveError}</s-paragraph>
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      {/*
        THE ASIDE CARRIES NO PAGE-SPECIFIC NOTE, and the card carries no prose
        at all now. Two facts were dropped on purpose and are stated nowhere on
        this page: that these tags apply only to products archived from here on,
        and that a product archived earlier remembers the tags it was archived
        with. Both are still TRUE — restore reads each product's own backup and
        never this list (see restoreProduct in quicktag-archive.server.ts) — so
        nothing here is a promise the server can break. They are simply not
        answered until a merchant asks, which is the trade this card is making.
      */}
      <WhatArchivingDoes />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
