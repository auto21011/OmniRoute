import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getModelPatchesFileInfo,
  saveModelPatchesContent,
  formatModelPatchesContent,
} from "@/lib/models/modelPatches";

const savePatchSchema = z.object({
  content: z.string(),
});

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const fileInfo = getModelPatchesFileInfo();
    return NextResponse.json(fileInfo);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load model patches";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = savePatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = saveModelPatchesContent(parsed.data.content);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error || "Failed to parse JSONC content",
          line: result.line,
          column: result.column,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      ruleCount: result.ruleCount,
      mtime: result.mtime,
      message: "Model patches saved and hot-reloaded successfully",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save model patches";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = savePatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  try {
    const formatted = formatModelPatchesContent(parsed.data.content);
    return NextResponse.json({
      success: true,
      formatted,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to format JSONC content";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
