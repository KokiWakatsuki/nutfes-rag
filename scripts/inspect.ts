/**
 * Supabase の現状を確認するスクリプト
 * 実行: tsx --env-file=.env.local scripts/inspect.ts
 */
import { createClient } from "@supabase/supabase-js";
import drives from "../config/drives.json";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function main() {
  console.log("=== Supabase 現状確認 ===\n");

  // --- テーブル存在確認 ---
  const tables = ["documents", "chat_sessions", "chat_messages", "rate_limits", "schema_migrations"];
  const tableStatus: Record<string, boolean> = {};
  for (const t of tables) {
    const { error } = await supabase.from(t).select("*", { count: "exact", head: true });
    tableStatus[t] = !error;
  }

  console.log("【テーブル】");
  for (const [t, exists] of Object.entries(tableStatus)) {
    console.log(`  ${exists ? "✅" : "❌"} ${t}`);
  }

  // --- ドキュメント統計 ---
  if (tableStatus["documents"]) {
    console.log("\n【documents テーブル】");

    const { count: totalCount } = await supabase
      .from("documents")
      .select("*", { count: "exact", head: true });
    console.log(`  総チャンク数: ${totalCount ?? "不明"}`);

    // drives.json の回次ごとに count クエリを発行（行フェッチ不要で正確）
    console.log("  回次別チャンク数:");
    const editions = drives.map((d) => d.edition).sort((a, b) => a - b);
    for (const ed of editions) {
      const { count } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("edition", ed);
      console.log(`    第${ed}回: ${count ?? "不明"} チャンク`);
    }

    // embedding 未生成チャンクの確認
    const { count: noEmbed } = await supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .is("embedding", null);
    if (noEmbed && noEmbed > 0) {
      console.log(`  ⚠️  embedding 未生成: ${noEmbed} チャンク`);
    } else {
      console.log(`  embedding: 全チャンク生成済み`);
    }
  }

  // --- チャットセッション統計 ---
  if (tableStatus["chat_sessions"]) {
    const { count } = await supabase
      .from("chat_sessions")
      .select("*", { count: "exact", head: true });
    const { count: msgCount } = await supabase
      .from("chat_messages")
      .select("*", { count: "exact", head: true });
    console.log("\n【chat_sessions / chat_messages】");
    console.log(`  セッション数: ${count ?? "不明"}`);
    console.log(`  メッセージ数: ${msgCount ?? "不明"}`);
  }

  // --- マイグレーション適用状況 ---
  console.log("\n【schema_migrations（適用済みマイグレーション）】");
  if (!tableStatus["schema_migrations"]) {
    console.log("  ❌ schema_migrations テーブルが存在しません（migrate 未実行）");
  } else {
    const { data: migrations } = await supabase
      .from("schema_migrations")
      .select("filename, applied_at")
      .order("filename");
    if (!migrations || migrations.length === 0) {
      console.log("  （適用済みなし）");
    } else {
      for (const m of migrations) {
        const date = new Date(m.applied_at).toLocaleString("ja-JP");
        console.log(`  ✅ ${m.filename}  (${date})`);
      }
    }
  }

  // --- 関数の存在確認 ---
  console.log("\n【RPC 関数確認】");
  const { error: matchErr } = await supabase.rpc("match_documents", {
    query_embedding: new Array(768).fill(0),
    match_count: 1,
    filter_editions: null,
    query_text: null,
  });
  console.log(`  match_documents (hybrid): ${matchErr ? "❌ " + matchErr.message : "✅"}`);

  const { error: rlErr } = await supabase.rpc("check_rate_limit", {
    p_email: "__inspect__",
    p_max_requests: 9999,
    p_window_ms: 1,
  });
  console.log(`  check_rate_limit:         ${rlErr ? "❌ " + rlErr.message : "✅"}`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
