export type SentryModule = typeof import("@sentry/browser");

export const loadSentry = (): Promise<SentryModule> => import("@sentry/browser");
