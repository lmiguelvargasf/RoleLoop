import { randomBytes, createHash } from "node:crypto";
import { settings } from "../src/server/config.js";
import { db } from "../src/server/store.js";

async function main() {
  const { count, error } = await db
    .from("app_admins")
    .select("user_id", { count: "exact", head: true });
  if (error)
    throw new Error("Run npm run setup to apply the account migrations first.");
  if (count)
    throw new Error(
      "An administrator is already configured. Sign in with that account to manage users.",
    );
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const { error: saveError } = await db.from("runtime").upsert({
    key: "owner-setup",
    payload: {
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt,
    },
    updated_at: new Date().toISOString(),
  });
  if (saveError) throw new Error("Could not create the one-time setup key.");
  const url = `${settings.appUrl}/?setup=${token}`;
  console.log(
    "Open this one-time local link, create or sign into your account, and claim the existing workspace:",
  );
  console.log(url);
  console.log(
    "Expires in 30 minutes. A new setup link invalidates the previous one. Keep it private.",
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Account setup failed.",
  );
  process.exitCode = 1;
});
