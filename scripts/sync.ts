import { syncAllDrives } from "../src/lib/sync";

async function main() {
  console.log("Drive 同期を開始します...");
  const result = await syncAllDrives();
  console.log(
    `完了: ${result.processed} 件処理 / ${result.skipped} 件DB済みスキップ / ${result.empty} 件空・破損 / ${result.errors} 件エラー`
  );
  if (result.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
