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
  const { error } = await supabase.rpc("truncate_documents");
  if (error) throw new Error(`削除失敗: ${error.message}`);

  // 削除が完全に完了したか件数で確認
  const { count, error: countError } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true });
  if (countError) throw new Error(`削除確認エラー: ${countError.message}`);
  if (count && count > 0) throw new Error(`TRUNCATE後もデータが残っています: ${count}件。再実行してください。`);

  console.log("✅ 削除確認OK（0件）。同期を開始します...\n");

  const result = await syncAllDrives();
  console.log(`\n=== 再インデックス完了 ===`);
  console.log(`処理: ${result.processed} / 空・破損: ${result.empty} / エラー: ${result.errors}`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
