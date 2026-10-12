import path from "node:path";

/**
 * Shared Remotion bundler override. Used by `remotion.config.ts` (Studio/CLI rendering)
 * and by `deploy.mjs` (Remotion Lambda site deployment).
 *
 * It adds the `@/*` -> `<cwd>/src/*` alias so that the Motion Specification compositions
 * can import the app modules exactly like the Next.js app does (tsconfig baseUrl/paths).
 */
export const webpackOverride = (config) => {
  const aliases = config.resolve?.alias;
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...(Array.isArray(aliases) ? {} : aliases ?? {}),
        "@": path.resolve(process.cwd(), "src"),
      },
    },
  };
};
