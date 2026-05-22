/**
 * 同期にかかる時間を事前に推定するスクリプト
 * ファイルのメタデータのみ取得（本文ダウンロードなし）
 *
 * 実行: npm run estimate
 */

import { google } from "googleapis";
import drives from "../config/drives.json";
import { getIndexedFileIds } from "../src/lib/supabase";

const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/pdf",
  "text/plain",
]);

const MIME_LABEL: Record<string, string> = {
  "application/vnd.google-apps.document": "Google ドキュメント",
  "application/vnd.google-apps.spreadsheet": "Google スプレッドシート",
  "application/vnd.google-apps.presentation": "Google スライド",
  "application/pdf": "PDF",
  "text/plain": "テキスト",
};

// ファイル種別ごとの平均チャンク数（経験則）
const AVG_CHUNKS: Record<string, number> = {
  "application/vnd.google-apps.document": 5,
  "application/vnd.google-apps.spreadsheet": 3,
  "application/vnd.google-apps.presentation": 4,
  "application/pdf": 0, // サイズから計算
  "text/plain": 0,      // サイズから計算
};

const CHUNK_SIZE = 1500;
const EMBED_INTERVAL_MS = 700;
const MAX_DAILY_REQUESTS = 1500;

function getAuthClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY!;
  const credentials = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

interface FileStats {
  id: string;
  name: string;
  mimeType: string;
  size: number; // bytes (0 if Google native file)
}

async function collectFiles(folderId: string): Promise<FileStats[]> {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const files: FileStats[] = [];

  async function walk(parentId: string) {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: "nextPageToken, files(id, name, mimeType, size)",
        pageToken,
        pageSize: 1000,
      });

      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name || !f.mimeType) continue;
        if (f.mimeType === "application/vnd.google-apps.folder") {
          process.stdout.write(".");
          await walk(f.id);
        } else if (SUPPORTED_MIME_TYPES.has(f.mimeType)) {
          files.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: Number(f.size ?? 0),
          });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  await walk(folderId);
  return files;
}

function estimateChunks(file: FileStats): number {
  const avg = AVG_CHUNKS[file.mimeType];
  if (avg > 0) return avg;
  // PDF・テキストはサイズから推定
  // PDF: 1 byte ≈ 0.8 char（バイナリ含むため割引）
  const estimatedChars =
    file.mimeType === "application/pdf" ? file.size * 0.8 : file.size;
  return Math.max(1, Math.ceil(estimatedChars / CHUNK_SIZE));
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)} 分`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return `${h} 時間 ${m} 分`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  同期時間推定ツール");
  console.log("=".repeat(60));

  let grandTotal = 0;
  let grandNew = 0;
  let grandChunks = 0;

  for (const { edition, driveId } of drives) {
    console.log(`\n【第${edition}回】フォルダをスキャン中... (サブフォルダを発見するたびに . を表示)`);
    const files = await collectFiles(driveId);
    console.log("");

    const indexedIds = new Set(await getIndexedFileIds(driveId));
    const newFiles = files.filter((f) => !indexedIds.has(f.id));

    // 種別ごとの集計
    const byType: Record<string, { count: number; size: number; chunks: number }> = {};
    let totalChunks = 0;
    let totalSize = 0;

    for (const f of newFiles) {
      const key = f.mimeType;
      if (!byType[key]) byType[key] = { count: 0, size: 0, chunks: 0 };
      const chunks = estimateChunks(f);
      byType[key].count++;
      byType[key].size += f.size;
      byType[key].chunks += chunks;
      totalChunks += chunks;
      totalSize += f.size;
    }

    console.log(`  合計ファイル数  : ${files.length.toLocaleString()} 件`);
    console.log(`  処理済み（スキップ）: ${indexedIds.size.toLocaleString()} 件`);
    console.log(`  未処理（今回対象）  : ${newFiles.length.toLocaleString()} 件`);
    console.log("");
    console.log("  種別内訳（未処理分）:");

    for (const [mime, stat] of Object.entries(byType)) {
      const label = MIME_LABEL[mime] ?? mime;
      console.log(
        `    ${label.padEnd(26)} ${String(stat.count).padStart(4)} 件  ${formatBytes(stat.size).padStart(8)}  推定 ${stat.chunks} チャンク`
      );
    }

    const timeMs = totalChunks * EMBED_INTERVAL_MS;
    const daysNeeded = Math.ceil(totalChunks / MAX_DAILY_REQUESTS);

    console.log("");
    console.log(`  推定チャンク数  : ${totalChunks.toLocaleString()} 回の Embedding API 呼び出し`);
    console.log(`  推定処理時間    : ${formatDuration(timeMs)}（API の応答時間を除く）`);
    if (daysNeeded > 1) {
      console.log(`  ⚠️  1日 ${MAX_DAILY_REQUESTS} 回の無料枠を超えるため、${daysNeeded} 日に分けて実行が必要です`);
    } else {
      console.log(`  ✅ 1日の無料枠（${MAX_DAILY_REQUESTS} 回）で完結します`);
    }

    grandTotal += files.length;
    grandNew += newFiles.length;
    grandChunks += totalChunks;
  }

  if (drives.length > 1) {
    console.log("\n" + "=".repeat(60));
    console.log("  全回次合計");
    console.log("=".repeat(60));
    console.log(`  合計ファイル数  : ${grandTotal.toLocaleString()} 件`);
    console.log(`  未処理ファイル  : ${grandNew.toLocaleString()} 件`);
    console.log(`  推定チャンク数  : ${grandChunks.toLocaleString()} 回`);
    console.log(`  推定処理時間    : ${formatDuration(grandChunks * EMBED_INTERVAL_MS)}`);
    const days = Math.ceil(grandChunks / MAX_DAILY_REQUESTS);
    if (days > 1) {
      console.log(`  ⚠️  合計 ${days} 日分かけて実行が必要です（毎日 npm run sync を実行）`);
    } else {
      console.log(`  ✅ 1日で完結します`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
