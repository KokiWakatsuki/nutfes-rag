/**
 * Supabase マイグレーションランナー（Management API 版）
 * DATABASE_URL 不要。Supabase Management API + PAT トークンで動作する。
 *
 * 必要な環境変数:
 *   SUPABASE_URL          - 既存（例: https://xxxx.supabase.co）
 *   SUPABASE_ACCESS_TOKEN - PAT（https://supabase.com/dashboard/account/tokens で発行）
 *
 * 実行: npm run migrate
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "../supabase/migrations");

function extractProjectRef(supabaseUrl: string): string {
  const match = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
  if (!match) throw new Error(`SUPABASE_URL の形式が不正です: ${supabaseUrl}`);
  return match[1];
}

async function execSql<T = unknown>(
  projectRef: string,
  accessToken: string,
  sql: string
): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: sql }),
    }
  );

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`SQL 実行失敗 (${res.status}): ${body}`);
  }
  try {
    return JSON.parse(body) as T[];
  } catch {
    return [];
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

  if (!supabaseUrl || !accessToken) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_ACCESS_TOKEN が未設定です。\n" +
        "SUPABASE_ACCESS_TOKEN は https://supabase.com/dashboard/account/tokens で発行できます。"
    );
  }

  const projectRef = extractProjectRef(supabaseUrl);
  console.log(`=== Supabase マイグレーション (project: ${projectRef}) ===\n`);

  // マイグレーション追跡テーブルを作成
  await execSql(
    projectRef,
    accessToken,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT        PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT now()
     )`
  );

  // 適用済みマイグレーションを取得
  const appliedRows = await execSql<{ filename: string }>(
    projectRef,
    accessToken,
    "SELECT filename FROM schema_migrations ORDER BY filename"
  );
  const applied = new Set(appliedRows.map((r) => r.filename));

  // ファイルを番号順に取得
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("マイグレーションファイルが見つかりません。");
    return;
  }

  let appliedCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  スキップ: ${file}`);
      continue;
    }

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");

    console.log(`  適用中: ${file} ...`);
    try {
      await execSql(projectRef, accessToken, sql);
      await execSql(
        projectRef,
        accessToken,
        `INSERT INTO schema_migrations (filename) VALUES ('${file.replace(/'/g, "''")}')`
      );
      console.log(`  ✅ 完了: ${file}`);
      appliedCount++;
    } catch (err) {
      console.error(`  ❌ 失敗: ${file}`);
      throw err;
    }
  }

  if (appliedCount === 0) {
    console.log("適用するマイグレーションはありません。全て適用済みです。");
  } else {
    console.log(`\n${appliedCount} 件のマイグレーションを適用しました。`);
  }
}

main().catch((err) => {
  console.error("\nエラー:", err.message ?? err);
  process.exit(1);
});
