import { hashPassword } from "../src/auth/session";

/**
 * Prints a FQMG_USERS credential record for one password:
 *   npm run auth:hash -- "<password>"
 * Then set FQMG_USERS="name:<printed value>[,name2:<value2>]" in .env.local.
 * The value never leaves the machine; nothing is written to the repository.
 */
const password = process.argv[2];
if (!password || password === "--help") {
  console.error('Usage: npm run auth:hash -- "<password>"');
  process.exit(1);
}
console.log(hashPassword(password));
