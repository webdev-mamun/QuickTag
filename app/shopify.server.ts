import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { seedQuickTagConfig } from "./quicktag.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  // Latest stable Admin API version. Keep this in sync with the `api_version`
  // in shopify.app.toml and in extensions/quicktag-action/shopify.extension.toml.
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // Custom / unlisted app: not distributed through the App Store.
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    /**
     * WHERE THIS RUNS: your local Node server, immediately after Shopify
     * redirects back from the OAuth grant — i.e. at install time.
     *
     * Seeds the app config metafield with the default managed tag, so the
     * product-page extensions work before the merchant has ever opened
     * Settings. Also migrates a v1.0 install's `tag_value` string into the v1.1
     * `config` blob — see seedQuickTagConfig.
     *
     * Failures are logged, not thrown: a broken seed must not break the
     * install, because every read falls back to the legacy key and then to the
     * documented default.
     */
    afterAuth: async ({ session, admin }) => {
      try {
        await seedQuickTagConfig(admin);
      } catch (error) {
        console.error(
          `QuickTag: failed to seed the default managed tag for ${session.shop}.`,
          error,
        );
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
