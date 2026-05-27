import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateEmbedding, generateAnswer } from "@/lib/gemini";
import {
  searchDocuments,
  createChatSession,
  touchChatSession,
  saveChatMessage,
} from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userEmail = session.user.email;

  const { question, editions, sessionId } = await req.json();
  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const filterEditions: number[] | null =
    Array.isArray(editions) && editions.length > 0 ? editions : null;

  // セッション管理
  let currentSessionId: string = sessionId ?? null;
  if (!currentSessionId) {
    const title = question.length > 40 ? question.slice(0, 40) + "…" : question;
    const newSession = await createChatSession(userEmail, title, filterEditions);
    currentSessionId = newSession.id;
  } else {
    await touchChatSession(currentSessionId);
  }

  await saveChatMessage(currentSessionId, "user", question, []);

  const embedding = await generateEmbedding(question);
  const docs = await searchDocuments(embedding, filterEditions);

  const sources = docs.map((d) => ({ fileName: d.file_name, edition: d.edition }));

  if (docs.length === 0) {
    const answer = "関連する資料が見つかりませんでした。";
    await saveChatMessage(currentSessionId, "assistant", answer, []);
    return NextResponse.json({ answer, sources: [], sessionId: currentSessionId });
  }

  const answer = await generateAnswer(question, docs);
  await saveChatMessage(currentSessionId, "assistant", answer, sources);

  return NextResponse.json({ answer, sources, sessionId: currentSessionId });
}
