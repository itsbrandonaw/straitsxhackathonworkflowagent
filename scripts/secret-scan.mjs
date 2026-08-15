import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SCANNER_VERSION = "happy-secret-scan/1.0.0";
const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".mp4", ".ico"]);
const patterns = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["AWS secret assignment", /AWS_SECRET_ACCESS_KEY\s*=\s*(?!replace|example|dummy|test)[^\s]+/gi],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["Generic secret assignment", /(?:api[_-]?key|secret|private[_-]?key|token)\s*[:=]\s*["']?(?!replace|example|dummy|test|\*{3})[A-Za-z0-9_+\/=.-]{20,}/gi]
];

const findings = [];
for (const file of tracked) {
  // `git ls-files` includes tracked paths deleted in the working tree until the
  // deletion is staged. A rollback must still be scannable before staging.
  if (!existsSync(file)) continue;
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (binaryExtensions.has(extension)) continue;
  const content = readFileSync(file, "utf8");
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line} ${label}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`${SCANNER_VERSION} found possible committed secrets:\n${findings.join("\n")}`);
  process.exit(1);
}

console.log(`${SCANNER_VERSION}: no possible secrets found in tracked text files`);
