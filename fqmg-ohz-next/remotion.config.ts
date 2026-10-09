import path from "node:path";
import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.overrideBundlerConfig((currentConfiguration) => {
  const aliases = currentConfiguration.resolve?.alias;
  return {
    ...currentConfiguration,
    resolve: {
      ...currentConfiguration.resolve,
      alias: {
        ...(Array.isArray(aliases) ? {} : aliases ?? {}),
        "@": path.resolve(process.cwd(), "src"),
      },
    },
  };
});
