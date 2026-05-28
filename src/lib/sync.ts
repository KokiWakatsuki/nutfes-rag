import drives from "../../config/drives.json";
import { listAllFiles, fetchFileContent, chunkText } from "./drive";
import { generateEmbeddingBatch, GeminiSkippableError } from "./gemini";
import { upsertDocument, getIndexedFiles, deleteStaleChunks } from "./supabase";

export interface SyncResult {
  processed: number;
  skipped: number;
  empty: number;
  errors: number;
}

const CONCURRENCY = 5;
const EMBED_BATCH_SIZE = 5;
// text-embedding-004: 20,000 tokens/request 上限
// 1800文字×5チャンク ≈ 5,000〜10,000 tokens で安全に収まる
const EMBED_INTERVAL_MS = 700;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIME_TO_EXT: Record<string, string> = {
  "application/vnd.google-apps.document": ".docx",
  "application/vnd.google-apps.spreadsheet": ".xlsx",
  "application/vnd.google-apps.presentation": ".pptx",
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function displayName(name: string, mimeType: string): string {
  if (name.includes(".")) return name;
  return name + (MIME_TO_EXT[mimeType] ?? "");
}

// Vertex AI 429 の種別を判定
// 日次クォータ超過 → true（全ワーカー停止）
// レート制限（一時的）→ false（リトライ可）
function isDailyQuotaExhausted(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("daily limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("insufficient_quota") ||
    lower.includes("daily quota") ||
    lower.includes("ratequotaexceeded")
  );
}

export async function syncAllDrives(): Promise<SyncResult> {
  let processed = 0;
  let skipped = 0;
  let empty = 0;
  let errors = 0;

  const syncTypes = process.env.SYNC_TYPES ?? "all";
  const typeLabels: Record<string, string> = {
    all: "全種別（PDF 含む）",
    "no-pdf": "PDF を除外",
    "docs-slides": "ドキュメント・スライドのみ",
    docs: "ドキュメントのみ",
  };
  console.log(`対象種別: ${typeLabels[syncTypes] ?? syncTypes} (SYNC_TYPES=${syncTypes})`);

  for (const { edition, driveId } of drives) {
    console.log(`\n=== 第${edition}回 (${driveId}) ===`);
    const result = await syncDrive(driveId, edition);
    processed += result.processed;
    skipped += result.skipped;
    empty += result.empty;
    errors += result.errors;
  }

  return { processed, skipped, empty, errors };
}

async function syncDrive(
  driveId: string,
  edition: number
): Promise<SyncResult> {
  console.log("ファイル一覧を取得中...");
  const files = await listAllFiles(driveId);
  const indexedFiles = await getIndexedFiles(driveId);

  // 未indexまたは更新済みファイルを処理対象とする
  const newFiles = files.filter((f) => {
    const storedModifiedAt = indexedFiles.get(f.id);
    if (storedModifiedAt === undefined) return true; // 未index
    if (storedModifiedAt === null) return false; // modifiedTime不明→スキップしない（既存データ保持）
    return f.modifiedTime > storedModifiedAt; // Drive更新日時が新しければ再index
  });
  const updatedCount = newFiles.filter((f) => indexedFiles.has(f.id)).length;
  console.log(
    `合計 ${files.length} 件 / 未処理 ${newFiles.length - updatedCount} 件 / 更新再index ${updatedCount} 件 / スキップ ${files.length - newFiles.length} 件`
  );

  const dbSkipped = files.length - newFiles.length;
  let processed = 0;
  let empty = 0;
  let errors = 0;
  let embedCallCount = 0;
  let nextIdx = 0;
  let completedCount = 0;
  let aborted = false;
  let firstFile = true;

  function printProgress(fileName?: string, final = false) {
    const done = completedCount;
    const total = newFiles.length;
    const w = total.toString().length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    const label = final ? "完了" : "進捗";
    const filePart = fileName ? ` | ${fileName}` : "";
    console.log(
      `[${label}] ${String(done).padStart(w)}/${total} (${String(pct).padStart(3)}%) | DB保存処理完了: ${String(processed).padStart(w)} | 空/破損スキップ: ${String(empty).padStart(w)} | エラー(要確認): ${String(errors).padStart(w)} | DB保存済みによりスキップ: ${String(dbSkipped).padStart(w)}${filePart}`
    );
  }

  async function worker() {
    while (!aborted) {
      const i = nextIdx++;
      if (i >= newFiles.length) break;

      const file = newFiles[i];

      try {
        let raw: string | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            raw = await fetchFileContent(file.id, file.mimeType);
            break;
          } catch (retryErr: unknown) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const isNetworkTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
            const isRateLimit = (msg.includes("429") || msg.toLowerCase().includes("resource exhausted")) && !isDailyQuotaExhausted(msg);
            const isTimeout = msg.includes("Gemini OCR timeout");

            if ((isNetworkTransient || isRateLimit || isTimeout) && attempt < 3) {
              const waitMs = isRateLimit ? 60_000 : isTimeout ? 15_000 : 3000 * (attempt + 1);
              const reason = isRateLimit ? "レート制限" : isTimeout ? "タイムアウト" : "一時障害";
              console.warn(`リトライ ${attempt + 1}/3 (${reason}, ${waitMs / 1000}秒待機): ${file.name}`);
              await sleep(waitMs);
              continue;
            }
            throw retryErr;
          }
        }
        if (raw === undefined) throw new GeminiSkippableError("空のレスポンス");
        const content = raw
          .replace(/\x00/g, "") // eslint-disable-line no-control-regex
          // 孤立サロゲート（U+D800–U+DFFF）は JSON で無効: PostgREST Aeson が "Empty or invalid json" を返すため除去
          // /u フラグで有効なサロゲートペア（U+10000以上の文字）を壊さずに孤立サロゲートのみ削除
          .replace(/[\uD800-\uDFFF]/gu, "");

        if (!content.trim()) {
          empty++;
          completedCount++;
          printProgress(displayName(file.name, file.mimeType));
          continue;
        }

        const chunks = chunkText(content);
        let lastWrittenIdx = -1;

        for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
          await sleep(EMBED_INTERVAL_MS);
          embedCallCount++;

          if (embedCallCount === 1400) {
            console.warn(
              "⚠️  Embedding API 呼び出しが 1400 回に達しました。上限まで残り少ないです。"
            );
          }

          const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
          const batchEmbeddings = await generateEmbeddingBatch(batch);

          if (firstFile && b === 0) {
            console.log(`  埋め込み次元数: ${batchEmbeddings[0]?.length ?? "不明"}`);
            firstFile = false;
          }

          // 生成直後に DB へ書き込み（全チャンク分メモリに保持しない）
          // upsert → stale削除の順（逆順だとクラッシュ時にデータ消失するため）
          for (let k = 0; k < batch.length; k++) {
            await upsertDocument({
              file_id: file.id,
              chunk_index: b + k,
              file_name: file.name,
              content: batch[k],
              edition,
              drive_id: driveId,
              drive_modified_at: file.modifiedTime || undefined,
              embedding: batchEmbeddings[k],
            });
            lastWrittenIdx = b + k;
          }
        }

        // 旧ファイルがより多くのチャンクを持っていた場合、余分なチャンクを削除
        if (indexedFiles.has(file.id)) {
          await deleteStaleChunks(file.id, lastWrittenIdx);
        }

        processed++;
        completedCount++;
        printProgress(displayName(file.name, file.mimeType));
      } catch (err: unknown) {
        // 破損ファイル・サイズ超過など永続的にスキップすべきエラー
        // tsx の ESM/CJS 境界で instanceof が失敗する場合があるため name でも判定
        if (err instanceof GeminiSkippableError || (err as Error)?.name === "GeminiSkippableError") {
          empty++;
          completedCount++;
          printProgress(displayName(file.name, file.mimeType));
          continue;
        }

        const msg = err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? String(err);

        // 日次クォータ超過のみ致命的エラーとして全ワーカーを停止
        if (isDailyQuotaExhausted(msg)) {
          console.error(`\n❌ API の1日の上限に達しました。明日以降に再実行してください。`);
          aborted = true;
          break;
        }
        errors++;
        completedCount++;
        console.error(`✗ エラー(要確認): ${displayName(file.name, file.mimeType)}: ${msg}`);
        printProgress(displayName(file.name, file.mimeType));
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  printProgress(undefined, true);
  return {
    processed,
    skipped: files.length - newFiles.length,
    empty,
    errors,
  };
}
