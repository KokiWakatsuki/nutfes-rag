/**
 * 全ドキュメントを削除してゼロから再インデックスするスクリプト
 * チャンクサイズ変更後などにデータを一貫した状態にするために使用する
 *
 * 実行: npm run reindex
 */
import { createClient } from "@supabase/supabase-js";
import { syncAllDrives } from "../src/lib/sync";

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  console.log("⚠️  documents テーブルの全レコードを削除します...");
  // .not("id", "is", null) = WHERE id IS NOT NULL → 全行対象
  const { error } = await supabase.from("documents").delete().not("id", "is", null);
  if (error) throw new Error(`削除失敗: ${error.message}`);
  console.log("✅ 削除完了。同期を開始します...\n");

  const result = await syncAllDrives();
  console.log(`\n=== 再インデックス完了 ===`);
  console.log(`処理: ${result.processed} / 空・破損: ${result.empty} / エラー: ${result.errors}`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
