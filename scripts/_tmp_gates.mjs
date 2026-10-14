import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, opts={}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 90000, shell: true, ...opts });
  console.log((r.stdout||"").slice(0,8000));
  console.log((r.stderr||"").slice(0,3000));
  console.log(`EXIT:${r.status}  signal:${r.signal}  error:${r.error||""}`);
  return r.status;
}

const cwd = "D:\\07_Programming\\vccode\\fqmg-ohz";
let ok = true;
let code;

code = run("npx", ["tsc","--noEmit"], { cwd });
if (code !== 0) ok = false;

code = run("npx", ["eslint",".","--max-warnings=0"], { cwd });
if (code !== 0) ok = false; // may be warnings

code = run("npx", ["vitest","run","--reporter=verbose"], { cwd });
if (code !== 0) ok = false;

console.log("\nGATES_DONE ok="+ok);
fs.writeFileSync("C:\\Users\\pc\\AppData\\Local\\Temp\\gates_result.txt", ok ? "OK" : "FAIL", "utf8");
