import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateEmbedding, streamGenerateAnswer, runAgenticSearchLoop } from "@/lib/gemini";
import {
  searchDocuments,
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

      // ユーザーメッセージを先に保存
      try {
        await saveChatMessage(sid, "user", question, []);
      } catch (err) {
        console.error("Failed to save user message:", err);
      }

      const collectedDocs: Document[] = [];
      const seenIds = new Set<string>();
      const allSources: Array<{ fileName: string; edition: number }> = [];
      const seenFileIds = new Set<string>();

      // Agentic 検索フェーズ: AIが自律的にクエリを決定・実行
      try {
        await runAgenticSearchLoop(
          question,
          history,
          async (query: string, fileKeywords?: string) => {
            send({ type: "searching", query });

            let docs: Document[] = [];
            try {
              const embedding = await generateEmbedding(query);
              docs = await searchDocuments(embedding, filterEditions, 12, fileKeywords, query);
            } catch (err) {
              console.error("Search error in agentic loop:", err);
              return "検索中にエラーが発生しました。";
            }

            for (const doc of docs) {
              if (!seenIds.has(doc.id)) {
                seenIds.add(doc.id);
                collectedDocs.push(doc);
              }
              if (!seenFileIds.has(doc.file_id)) {
                seenFileIds.add(doc.file_id);
                allSources.push({ fileName: doc.file_name, edition: doc.edition });
              }
            }

            if (docs.length === 0) return "該当する資料が見つかりませんでした。";

            return docs.map((d, i) => {
              const folderMatch = d.content.match(/^【フォルダ: ([^\]]+)】/);
              const folderLine = folderMatch ? `フォルダ: ${folderMatch[1]}` : "";
              const body = folderMatch ? d.content.slice(folderMatch[0].length).trimStart() : d.content;
              return `[${i + 1}] ${d.file_name}（第${d.edition}回）${folderLine ? " | " + folderLine : ""}\n${body.slice(0, 600)}`;
            }).join("\n\n---\n\n");
          }
        );
      } catch (err) {
        console.error("Agentic search loop error:", err);
        // フォールバック: シンプルな1回検索
        try {
          send({ type: "searching", query: question });
          const embedding = await generateEmbedding(question);
          const docs = await searchDocuments(embedding, filterEditions, 12, undefined, question);
          for (const doc of docs) {
            if (!seenIds.has(doc.id)) {
              seenIds.add(doc.id);
              collectedDocs.push(doc);
            }
            if (!seenFileIds.has(doc.file_id)) {
              seenFileIds.add(doc.file_id);
              allSources.push({ fileName: doc.file_name, edition: doc.edition });
            }
          }
        } catch (fallbackErr) {
          console.error("Fallback search error:", fallbackErr);
        }
      }

      // 検索完了 → ソース確定
      send({ type: "sources_update", sources: allSources });

      // 最大20件に絞って回答生成
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
