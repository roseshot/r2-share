import { readFileSync, writeFileSync } from "node:fs";

const databaseId = process.env.D1_DATABASE_ID?.trim();
const databaseName = process.env.D1_DATABASE_NAME?.trim();
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!databaseName) {
  throw new Error("D1_DATABASE_NAME is required");
}
if (!databaseId) {
  throw new Error("D1_DATABASE_ID is required");
}
if (!validId.test(databaseId)) {
  throw new Error("D1_DATABASE_ID must be a UUID");
}
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(databaseName)) {
  throw new Error("D1_DATABASE_NAME is invalid");
}

const base = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
base.d1_databases = [{
  binding: "DB",
  database_name: databaseName,
  database_id: databaseId,
  migrations_dir: "database/migrations",
}];
writeFileSync("wrangler.generated.jsonc", JSON.stringify(base, null, 2) + "\n");
