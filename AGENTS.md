# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

Before writing or modifying any Shopify API/platform code (Admin API calls, metafields, extension targets, webhooks, scopes, API version), check the current version and current best practice via the Toolkit first — don't rely on prior training knowledge or existing repo patterns as the source of truth for what's current.
