import {
  deployFunction,
  deploySite,
  getOrCreateBucket,
} from "@remotion/lambda";
import dotenv from "dotenv";
import path from "path";
import { DISK, RAM, REGION, SITE_NAME, TIMEOUT } from "./config.mjs";
import { webpackOverride } from "./src/remotion/webpack-override.mjs";

// Phase 6: EXPLICIT deployment command (npm run deploy:lambda) — never part
// of any build. Fails loudly (non-zero exit) without AWS credentials.
console.log("Selected region:", REGION);
dotenv.config({quiet: true});

if (!process.env.AWS_ACCESS_KEY_ID && !process.env.REMOTION_AWS_ACCESS_KEY_ID) {
  console.error(
    'ERROR: "REMOTION_AWS_ACCESS_KEY_ID" (or AWS_ACCESS_KEY_ID) is not set. Refusing to run an incomplete Lambda deployment.',
  );
  console.error(
    "Complete the Lambda setup first: https://www.remotion.dev/docs/lambda/setup",
  );
  process.exit(1);
}
if (
  !process.env.AWS_SECRET_ACCESS_KEY &&
  !process.env.REMOTION_AWS_SECRET_ACCESS_KEY
) {
  console.error(
    'ERROR: "REMOTION_AWS_SECRET_ACCESS_KEY" (or AWS_SECRET_ACCESS_KEY) is not set. Refusing to run an incomplete Lambda deployment.',
  );
  console.error(
    "Complete the Lambda setup first: https://www.remotion.dev/docs/lambda/setup",
  );
  process.exit(1);
}

process.stdout.write("Deploying Lambda function... ");

const { functionName, alreadyExisted: functionAlreadyExisted } =
  await deployFunction({
    createCloudWatchLogGroup: true,
    memorySizeInMb: RAM,
    region: REGION,
    timeoutInSeconds: TIMEOUT,
    diskSizeInMb: DISK,
  });
console.log(
  functionName,
  functionAlreadyExisted ? "(already existed)" : "(created)",
);

process.stdout.write("Ensuring bucket... ");
const { bucketName, alreadyExisted: bucketAlreadyExisted } =
  await getOrCreateBucket({
    region: REGION,
  });
console.log(
  bucketName,
  bucketAlreadyExisted ? "(already existed)" : "(created)",
);

process.stdout.write("Deploying site... ");
const { siteName } = await deploySite({
  bucketName,
  // The unified official composition (data-only, FQMG-OHZ-Preview).
  entryPoint: path.join(process.cwd(), "src", "remotion", "entry.tsx"),
  siteName: SITE_NAME,
  region: REGION,
  options: { webpackOverride },
});

console.log(siteName);

console.log();
console.log("You now have everything you need to render videos!");
console.log("Re-run this command when:");
console.log("  1) you changed the video template");
console.log("  2) you changed config.mjs");
console.log("  3) you upgraded Remotion to a newer version");
