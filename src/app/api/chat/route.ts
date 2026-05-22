import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateEmbedding, generateAnswer } from "@/lib/gemini";
import { searchDocuments } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { question, edition } = await req.json();
  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const filterEdition: number | null =
    edition && Number.isInteger(Number(edition)) ? Number(edition) : null;

  const embedding = await generateEmbedding(question);
  const docs = await searchDocuments(embedding, filterEdition);

  if (docs.length === 0) {
    return NextResponse.json({
      answer: "関連する資料が見つかりませんでした。",
      sources: [],
    });
  }

  const answer = await generateAnswer(question, docs);

  return NextResponse.json({
    answer,
    sources: docs.map((d) => ({
      fileName: d.file_name,
      edition: d.edition,
    })),
  });
}
