// See all configuration options: https://remotion.dev/docs/config
// Each option also is available as a CLI flag: https://remotion.dev/docs/cli

// Note: When using the Node.JS APIs, the config file doesn't apply. Instead, pass options directly to the APIs

import { Config } from "@remotion/cli/config";
import { webpackOverride } from "./src/remotion/webpack-override.mjs";

// Config.setRspack(true) removed (D-026): under rspack the bundler ignores
// overrideBundlerConfig, so the `@/*` alias never applies and entry.tsx fails
// to resolve its app imports during studio / render / deploy bundling.
Config.setVideoImageFormat("jpeg");

Config.overrideBundlerConfig(webpackOverride);
