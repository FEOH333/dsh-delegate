// One-shot verification: syntax-check every source file and run both smoke
// suites. Requires the dsh packages to be resolvable (see README dev notes).
// Run with:  npm run verify   (or)   node scripts/verify.mjs
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir, out = []) => {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(js|mjs)$/.test(name) && name !== "verify.mjs") out.push(p);
	}
	return out;
};

const sources = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "test"))];
let failed = 0;
for (const file of sources) {
	const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	if (result.status !== 0) {
		failed += 1;
		console.error(`syntax FAIL: ${file}\n${result.stderr ?? result.stdout}`);
	} else {
		console.log(`syntax ok: ${file.replace(ROOT, "")}`);
	}
}

for (const suite of ["test/smoke.mjs", "test/client-smoke.mjs"]) {
	const result = spawnSync(process.execPath, [suite], { cwd: ROOT, encoding: "utf8" });
	if (result.status !== 0) {
		failed += 1;
		console.error(`${suite} FAILED:\n${result.stdout}${result.stderr}`);
	} else {
		console.log(`${suite}: passed`);
	}
}

if (failed > 0) {
	console.error(`verify failed (${failed} problem(s))`);
	process.exit(1);
}
console.log("verify: all clear");