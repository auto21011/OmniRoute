/**
 * src/app/api/models/patches/entry/route.ts
 *
 * REST endpoint for individual patch rule CRUD (used by the Visual UI Editor).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  upsertModelPatchEntry,
  deleteModelPatchEntry,
  type ModelPatch,
} from "@/lib/models/modelPatches";

const upsertSchema = z.object({
  provider: z.string().min(1, "Provider is required"),
  modelPattern: z.string().min(1, "Model pattern or ID is required"),
  patch: z.record(z.unknown()).optional(),
  oldProvider: z.string().optional(),
  oldModelPattern: z.string().optional(),
});

const deleteSchema = z.object({
  provider: z.string().min(1, "Provider is required"),
  modelPattern: z.string().min(1, "Model pattern is required"),
});

export async function POST(req: Request) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const parsed = upsertSchema.safeParse(rawBody);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map((i) => i.message).join(", ");
    return NextResponse.json({ success: false, ok: false, error: errorMsg }, { status: 400 });
  }

  const { provider, modelPattern, patch, oldProvider, oldModelPattern } = parsed.data;

  try {
    const result = upsertModelPatchEntry(
      provider.trim().toLowerCase(),
      modelPattern.trim(),
      (patch || {}) as ModelPatch,
      {
        oldProvider: oldProvider ? oldProvider.trim().toLowerCase() : undefined,
        oldModelPattern: oldModelPattern ? oldModelPattern.trim() : undefined,
      }
    );

    if (!result.ok) {
      return NextResponse.json(
        { success: false, ok: false, error: result.error || "Failed to save patch entry" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      ok: true,
      message: `Successfully saved patch rule for "${provider}/${modelPattern}"`,
      ruleCount: result.ruleCount,
      mtime: result.mtime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const parsed = deleteSchema.safeParse(rawBody);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map((i) => i.message).join(", ");
    return NextResponse.json({ success: false, ok: false, error: errorMsg }, { status: 400 });
  }

  const { provider, modelPattern } = parsed.data;

  try {
    const result = deleteModelPatchEntry(provider.trim().toLowerCase(), modelPattern.trim());

    if (!result.ok) {
      return NextResponse.json(
        { success: false, ok: false, error: result.error || "Failed to delete patch entry" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      ok: true,
      message: `Successfully deleted patch rule for "${provider}/${modelPattern}"`,
      ruleCount: result.ruleCount,
      mtime: result.mtime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, ok: false, error: message }, { status: 500 });
  }
}
