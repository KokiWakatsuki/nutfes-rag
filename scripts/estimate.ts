/**
 * 同期にかかる時間を事前に推定するスクリプト
 * ファイルのメタデータのみ取得（本文ダウンロードなし）
 *
 * 実行: npm run estimate
 */

import { google } from "googleapis";
import drives from "../config/drives.json";
import { getIndexedFileIds } from "../src/lib/supabase";

const MIME = {
  DOC:   "application/vnd.google-apps.document",
  SHEET: "application/vnd.google-apps.spreadsheet",
  SLIDE: "application/vnd.google-apps.presentation",
  PDF:   "application/pdf",
  TXT:   "text/plain",
  FOLDER: "application/vnd.google-apps.folder",
} as const;

const ALL_SUPPORTED = new Set([MIME.DOC, MIME.SHEET, MIME.SLIDE, MIME.PDF, MIME.TXT]);

const MIME_LABEL: Record<string, string> = {
  [MIME.DOC]:   "Google ドキュメント",
  [MIME.SHEET]: "Google スプレッドシート",
  [MIME.SLIDE]: "Google スライド",
  [MIME.PDF]:   "PDF",
  [MIME.TXT]:   "テキスト",
};

// ファイル種別ごとの平均チャンク数（経験則）
const AVG_CHUNKS: Record<string, number> = {
  [MIME.DOC]:   5,
  [MIME.SHEET]: 3,
  [MIME.SLIDE]: 4,
  [MIME.PDF]:   0,  // サイズから計算（PDF テキスト率 8% で推定）
  [MIME.TXT]:   0,  // サイズから計算
};

// PDF はファイルサイズの 8% 程度がテキスト（残りは画像・フォント等）
const PDF_TEXT_RATIO = 0.08;
const CHUNK_SIZE = 1500;
const EMBED_INTERVAL_MS = 700;
const MAX_DAILY_REQUESTS = 1500;

// 1時間以内に収まるチャンク上限（API 応答時間を含め余裕を持たせる）
const HOURLY_LIMIT = 1200;

// フィルタリングシナリオ
const SCENARIOS = [
  {
    label: "① 全種別（PDF 含む）",
    types: new Set([MIME.DOC, MIME.SHEET, MIME.SLIDE, MIME.PDF, MIME.TXT]),
  },
  {
    label: "② PDF を除外",
    types: new Set([MIME.DOC, MIME.SHEET, MIME.SLIDE, MIME.TXT]),
  },
  {
    label: "③ ドキュメント・スライドのみ",
    types: new Set([MIME.DOC, MIME.SLIDE]),
  },
  {
    label: "④ ドキュメントのみ",
    types: new Set([MIME.DOC]),
  },
];

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
  size: number;
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
        if (f.mimeType === MIME.FOLDER) {
          process.stdout.write(".");
          await walk(f.id);
        } else if (ALL_SUPPORTED.has(f.mimeType as never)) {
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
  const estimatedChars =
    file.mimeType === MIME.PDF ? file.size * PDF_TEXT_RATIO : file.size;
  return Math.max(1, Math.ceil(estimatedChars / CHUNK_SIZE));
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `約 ${Math.ceil(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `約 ${Math.ceil(ms / 60_000)} 分`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return `約 ${h} 時間 ${m} 分`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function main() {
  console.log("=".repeat(62));
  console.log("  同期時間推定ツール");
  console.log("=".repeat(62));

  // 全ドライブのファイルを収集
  const allFilesByDrive: Array<{ edition: number; driveId: string; files: FileStats[]; indexedIds: Set<string> }> = [];

  for (const { edition, driveId } of drives) {
    console.log(`\n【第${edition}回】スキャン中... (. = サブフォルダ発見)`);
    const files = await collectFiles(driveId);
    const indexedIds = new Set(await getIndexedFileIds(driveId));
    allFilesByDrive.push({ edition, driveId, files, indexedIds });
    console.log(` → ${files.length} 件（処理済み: ${indexedIds.size} 件）`);
  }

  // 種別ごとの件数・サイズ集計（未処理分）
  const typeSummary: Record<string, { count: number; size: number; chunks: number }> = {};
  for (const { files, indexedIds } of allFilesByDrive) {
    for (const f of files) {
      if (indexedIds.has(f.id)) continue;
      if (!typeSummary[f.mimeType]) typeSummary[f.mimeType] = { count: 0, size: 0, chunks: 0 };
      typeSummary[f.mimeType].count++;
      typeSummary[f.mimeType].size += f.size;
      typeSummary[f.mimeType].chunks += estimateChunks(f);
    }
  }

  console.log("\n" + "=".repeat(62));
  console.log("  種別ごとの内訳（未処理分）");
  console.log("=".repeat(62));
  let totalFiles = 0;
  let totalChunks = 0;
  for (const [mime, s] of Object.entries(typeSummary)) {
    const label = MIME_LABEL[mime] ?? mime;
    console.log(
      `  ${label.padEnd(24)} ${String(s.count).padStart(4)} 件  ${formatBytes(s.size).padStart(8)}  推定 ${s.chunks} チャンク`
    );
    totalFiles += s.count;
    totalChunks += s.chunks;
  }
  console.log(`  ${"合計".padEnd(24)} ${String(totalFiles).padStart(4)} 件            推定 ${totalChunks} チャンク`);

  // シナリオ比較
  console.log("\n" + "=".repeat(62));
  console.log("  フィルタリングシナリオ比較");
  console.log("=".repeat(62));

  let recommendedScenario = "";

  for (const scenario of SCENARIOS) {
    let files = 0;
    let chunks = 0;
    for (const [mime, s] of Object.entries(typeSummary)) {
      if (scenario.types.has(mime as never)) {
        files += s.count;
        chunks += s.chunks;
      }
    }
    const timeMs = chunks * EMBED_INTERVAL_MS;
    const days = Math.ceil(chunks / MAX_DAILY_REQUESTS);
    const fits = chunks <= HOURLY_LIMIT;
    const marker = fits ? "✅" : "❌";

    console.log(`\n  ${scenario.label}`);
    console.log(`    対象ファイル : ${files} 件`);
    console.log(`    推定チャンク : ${chunks} 回`);
    console.log(`    推定時間     : ${formatDuration(timeMs)}`);
    if (days > 1) {
      console.log(`    ${marker} ${days} 日に分けて実行が必要`);
    } else {
      console.log(`    ${marker} 1日で完結（${fits ? "1時間以内の目標を達成" : "1時間を超える可能性あり"}）`);
    }

    if (fits && !recommendedScenario) {
      recommendedScenario = scenario.label;
    }
  }

  console.log("\n" + "=".repeat(62));
  if (recommendedScenario) {
    console.log(`  推奨: ${recommendedScenario}`);
    console.log(`  → SYNC_TYPES 環境変数でフィルタを設定してから npm run sync を実行`);
  } else {
    console.log("  ⚠️  いずれのシナリオも1時間を超えます");
    console.log("  ドキュメントのみ（④）から始めて動作確認することを推奨します");
  }
  console.log("=".repeat(62));
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
