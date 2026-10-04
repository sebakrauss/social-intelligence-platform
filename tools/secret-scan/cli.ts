/**
 * Secret scan over the files git would track: tracked files plus untracked, non-ignored ones.
 * Exits 1 on any finding. Prints only file:line and rule id, never the matched value.
 * Run: `npm run secret-scan`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { formatFinding, isExcludedPath, isScannableContent, scanText, type Finding } from "./scan.ts";

function candidateFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter((file) => file !== ""))];
}

const findings: Finding[] = [];
let scanned = 0;

for (const file of candidateFiles()) {
  if (isExcludedPath(file)) {
    continue;
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  if (!isScannableContent(bytes)) {
    continue;
  }
  scanned += 1;
  findings.push(...scanText(file, new TextDecoder().decode(bytes)));
}

if (findings.length > 0) {
  console.error(`secret-scan: ${String(findings.length)} finding(s) in ${String(scanned)} files (values not shown):`);
  for (const finding of findings) {
    console.error(`  ${formatFinding(finding)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`secret-scan: ${String(scanned)} files scanned, no findings`);
}
