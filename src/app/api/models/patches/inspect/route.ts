import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { inspectModelPatch } from "@/lib/models/modelPatches";

const inspectSchema = z.object({
  modelId: z.string().min(1),
  provider: z.string().optional(),
});

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = inspectSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await inspectModelPatch(parsed.data.provider, parsed.data.modelId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to inspect model patch";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
