import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { checkUpstreamNimCoverage } from "@/lib/models/modelPatches";

const checkUpstreamSchema = z.object({
  apiKey: z.string().optional(),
});

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    // empty body is acceptable
  }

  const parsed = checkUpstreamSchema.safeParse(rawBody);
  const apiKey = parsed.success ? parsed.data.apiKey : undefined;

  try {
    const result = await checkUpstreamNimCoverage(apiKey);
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check upstream models";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
