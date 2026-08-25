/**
 * Types for the extension sandbox, for your editor's benefit only.
 *
 * The `@shopify/ui-extensions/<target>` entry is a types-only module: importing
 * it registers the `s-*` Polaris web components that this particular target is
 * allowed to render, and gives us the shape of the `shopify` global.
 *
 * `shopify` has no import because the extension does not create it — Shopify
 * injects it into the sandbox at runtime.
 *
 * Note the target differs from the action's: a block gets `data`, `navigation`,
 * `picker` and `resourcePicker` on top of the standard surface.
 */
import type { Api } from "@shopify/ui-extensions/admin.product-details.block.render";

declare global {
  const shopify: Api;
}

export {};
