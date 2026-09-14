// Tiny JSON reader so demo.sh does not depend on jq.
// Usage: cat response.json | node scripts/json.cjs job.id
const fs = require("node:fs");

const path = process.argv[2] || "";
let value;

try {
  value = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.stdout.write("");
  process.exit(0);
}

for (const key of path.split(".").filter(Boolean)) {
  if (value == null) break;
  value = value[key];
}

if (value === undefined || value === null) {
  process.stdout.write("");
} else if (typeof value === "object") {
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write(String(value));
}
