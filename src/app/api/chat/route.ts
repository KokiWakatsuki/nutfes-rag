import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateEmbedding, streamGenerateAnswer, runAgenticSearchLoop } from "@/lib/gemini";
import {
  searchDocuments,
  listFilesByPath,
  getFileChunks,
  createChatSession,
  getChatSession,
  touchChatSession,
  saveChatMessage,
  checkRateLimit,
  type Document,
} from "@/lib/supabase";

export const maxDuration = 300;

async function setupSession(
  userEmail: string,
  sessionId: string | null,
  question: string,
  filterEditions: number[] | null
): Promise<{ sessionId: string; history: Array<{ role: "user" | "assistant"; content: string }> }> {
  if (!sessionId) {
    const title = question.length > 40 ? question.slice(0, 40) + "…" : question;
    const newSession = await createChatSession(userEmail, title, filterEditions);
    return { sessionId: newSession.id, history: [] };
  }
  const [sessionData] = await Promise.all([
    getChatSession(sessionId, userEmail),
    touchChatSession(sessionId),
  ]);
  const history = sessionData?.messages.map((m) => ({ role: m.role, content: m.content })) ?? [];
  return { sessionId, history };
}

function formatDocForAI(d: Document, index: number): string {
  const folderMatch = d.content.match(/^【フォルダ: ([^\]]+)】/);
  const folderLine = folderMatch ? `フォルダ: ${folderMatch[1]}` : "";
  const body = folderMatch ? d.content.slice(folderMatch[0].length).trimStart() : d.content;
  return `[${index + 1}] ${d.file_name}（第${d.edition}回）${folderLine ? " | " + folderLine : ""}\n${body.slice(0, 600)}`;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userEmail = session.user.email;

  if (!(await checkRateLimit(userEmail))) {
    return NextResponse.json({ error: "Too many requests. 1分後に再度お試しください。" }, { status: 429 });
  }

  const { question, editions, sessionId } = await req.json();
  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const filterEditions: number[] | null =
    Array.isArray(editions) && editions.length > 0 ? editions : null;

  let currentSessionId: string;
  let history: Array<{ role: "user" | "assistant"; content: string }>;

  try {
    ({ sessionId: currentSessionId, history } = await setupSession(
      userEmail, sessionId ?? null, question, filterEditions
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `初期化エラー: ${message}` }, { status: 500 });
  }

  const sid = currentSessionId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      send({ type: "meta", sessionId: sid, sources: [] });

      try {
        await saveChatMessage(sid, "user", question, []);
      } catch (err) {
        console.error("Failed to save user message:", err);
      }

      const collectedDocs: Document[] = [];
      const seenIds = new Set<string>();
      const allSources: Array<{ fileName: string; edition: number }> = [];
      const seenFileIds = new Set<string>();

      function addDocs(docs: Document[]) {
        for (const doc of docs) {
          if (!seenIds.has(doc.id)) { seenIds.add(doc.id); collectedDocs.push(doc); }
          if (!seenFileIds.has(doc.file_id)) { seenFileIds.add(doc.file_id); allSources.push({ fileName: doc.file_name, edition: doc.edition }); }
        }
      }

      // UIで年度が選択されていればそれを優先、未選択ならAI検出値を使用
      function resolveEditions(aiSingle?: number, aiArray?: number[]): number[] | null {
        if (filterEditions) return filterEditions;
        if (aiArray && aiArray.length > 0) return aiArray;
        if (aiSingle != null) return [aiSingle];
        return null;
      }

      // Agentic 検索フェーズ: 3ツールを自律的に呼び出す
      try {
        await runAgenticSearchLoop(
          question,
          history,
          async (name: string, args: Record<string, unknown>) => {

            // ── search_documents ──────────────────────────────────────
            if (name === "search_documents") {
              const query = args.query as string;
              const fileKeywords = args.file_keywords as string | undefined;
              const rawEditions = args.editions;
              const aiEditions = Array.isArray(rawEditions)
                ? (rawEditions as unknown[]).map(Number).filter((n) => !isNaN(n))
                : undefined;

              send({ type: "searching", query });

              let docs: Document[] = [];
              try {
                const embedding = await generateEmbedding(query);
                docs = await searchDocuments(embedding, resolveEditions(undefined, aiEditions), 12, fileKeywords, query);
              } catch (err) {
                console.error("search_documents error:", err);
                return "検索中にエラーが発生しました。";
              }

              addDocs(docs);
              if (docs.length === 0) return "該当する資料が見つかりませんでした。";
              return docs.map(formatDocForAI).join("\n\n---\n\n");
            }

            // ── list_files ────────────────────────────────────────────
            if (name === "list_files") {
              const pathPattern = args.path_pattern as string;
              const aiEdition = args.edition != null ? Number(args.edition) : undefined;
              const effectiveEdition = resolveEditions(aiEdition)?.[0];

              send({ type: "searching", query: `フォルダ「${pathPattern}」を確認中` });

              try {
                const files = await listFilesByPath(pathPattern, effectiveEdition);
                if (files.length === 0) return `「${pathPattern}」に一致するファイルは見つかりませんでした。`;
                return `【ファイル一覧: ${pathPattern}】\n` +
                  files.map((f) => `- ${f.file_name}（第${f.edition}回）${f.folder_path ? " | " + f.folder_path : ""}`).join("\n");
              } catch (err) {
                console.error("list_files error:", err);
                return "ファイル一覧の取得中にエラーが発生しました。";
              }
            }

            // ── get_file_content ──────────────────────────────────────
            if (name === "get_file_content") {
              const fileName = args.file_name as string;
              const aiEdition = args.edition != null ? Number(args.edition) : undefined;
              const effectiveEdition = resolveEditions(aiEdition)?.[0];

              send({ type: "searching", query: `「${fileName}」を読み込み中` });

              try {
                const chunks = await getFileChunks(fileName, effectiveEdition);
                if (chunks.length === 0) return `「${fileName}」というファイルは見つかりませんでした。`;

                // collectedDocs に追加（回答生成に使用）
                for (const chunk of chunks) {
                  if (!seenIds.has(chunk.id)) {
                    seenIds.add(chunk.id);
                    collectedDocs.push({
                      id: chunk.id,
                      file_id: chunk.file_id,
                      file_name: chunk.file_name,
                      content: chunk.content,
                      edition: chunk.edition,
                      drive_id: "",
                      created_at: "",
                      updated_at: "",
                    } as Document);
                  }
                  if (!seenFileIds.has(chunk.file_id)) {
                    seenFileIds.add(chunk.file_id);
                    allSources.push({ fileName: chunk.file_name, edition: chunk.edition });
                  }
                }

                // AIへ全文を返す（フォルダプレフィックスは除く）
                const fullText = chunks.map((c) => {
                  const folderMatch = c.content.match(/^【フォルダ: ([^\]]+)】/);
                  return folderMatch ? c.content.slice(folderMatch[0].length).trimStart() : c.content;
                }).join("\n");

                return `【${chunks[0].file_name}（第${chunks[0].edition}回）全文】\n${fullText.slice(0, 8000)}`;
              } catch (err) {
                console.error("get_file_content error:", err);
                return "ファイル内容の取得中にエラーが発生しました。";
              }
            }

            return "不明なツールです。";
          }
        );
      } catch (err) {
        console.error("Agentic search loop error:", err);
        // フォールバック: シンプルな1回検索
        try {
          send({ type: "searching", query: question });
          const embedding = await generateEmbedding(question);
          const docs = await searchDocuments(embedding, filterEditions, 12, undefined, question);
          addDocs(docs);
        } catch (fallbackErr) {
          console.error("Fallback search error:", fallbackErr);
        }
      }

      send({ type: "sources_update", sources: allSources });

      const finalDocs = collectedDocs.slice(0, 20);
      let fullText = "";

      if (finalDocs.length === 0) {
        fullText = "関連する資料が見つかりませんでした。";
        send({ type: "text", text: fullText });
      } else {
        try {
          for await (const chunk of streamGenerateAnswer(question, finalDocs, history)) {
            fullText += chunk;
            send({ type: "text", text: chunk });
          }
        } catch (err) {
          send({ type: "error", message: String(err) });
        }
      }

      try {
        await saveChatMessage(sid, "assistant", fullText || "エラーが発生しました。", allSources);
      } catch (saveErr) {
        console.error("Failed to save assistant message:", saveErr);
      }

      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
