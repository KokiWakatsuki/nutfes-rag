import { syncAllDrives } from "../src/lib/sync";

async function main() {
  console.log("Starting Drive sync...");
  const result = await syncAllDrives();
  console.log(
    `Done: ${result.processed} processed, ${result.skipped} skipped(DB済み), ${result.empty} empty, ${result.errors} errors`
  );
  if (result.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
