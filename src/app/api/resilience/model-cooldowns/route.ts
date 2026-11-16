import { NextResponse } from "next/server";
import { z } from "zod";
import {
  clearModelUnavailability,
  clearConnectionModelUnavailability,
  clearConnectionAllModelUnavailability,
  getAvailabilityReport,
  lockModelAvailability,
  resetAllAvailability,
} from "@/domain/modelAvailability";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const deleteCooldownSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    connectionId: z.string().optional(),
    all: z.boolean().optional(),
  })
  .passthrough();

const createCooldownSchema = z
  .object({
    provider: z.string().min(1, "provider is required"),
    model: z.string().min(1, "model is required"),
    durationMs: z.number().positive("durationMs must be positive"),
    connectionId: z.string().optional().nullable(),
    reason: z.string().optional(),
    scope: z.enum(["connection", "provider"]).optional(),
  })
  .passthrough();

function getErrorMessage(error: unknown, fallback: string): string {
  return sanitizeErrorMessage(error) || fallback;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const items = getAvailabilityReport().sort((a, b) => b.remainingMs - a.remainingMs);
    return NextResponse.json({ items });
  } catch (error: unknown) {
    console.error("[API] GET /api/resilience/model-cooldowns error:", error);
    return NextResponse.json(
      { error: getErrorMessage(error, "Failed to load cooldowns") },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const rawBody = await request.json().catch(() => ({}));
    const validation = validateBody(createCooldownSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;

    const provider = body.provider.trim();
    const model = body.model.trim();
    const durationMs = body.durationMs;
    const connectionId = body.connectionId ? body.connectionId.trim() : undefined;
    const reason = body.reason?.trim() || "manual_disable";
    const scope = body.scope || (connectionId ? "connection" : "provider");

    const result = await lockModelAvailability({
      provider,
      model,
      durationMs,
      connectionId,
      reason,
      scope,
    });

    return NextResponse.json({
      ok: true,
      lockedCount: result.lockedCount,
      until: Date.now() + durationMs,
    });
  } catch (error: unknown) {
    console.error("[API] POST /api/resilience/model-cooldowns error:", error);
    return NextResponse.json(
      { error: getErrorMessage(error, "Failed to create model lockout") },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const rawBody = await request.json().catch(() => ({}));
    const validation = validateBody(deleteCooldownSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;

    if (body.all) {
      resetAllAvailability();
      return NextResponse.json({ ok: true, clearedAll: true });
    }

    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";

    if (provider && connectionId && !model) {
      const clearedCount = clearConnectionAllModelUnavailability(provider, connectionId);
      return NextResponse.json({ ok: true, clearedCount });
    }

    if (!provider || !model) {
      return NextResponse.json({ error: "provider and model are required" }, { status: 400 });
    }

    let removed = false;
    if (connectionId) {
      removed = clearConnectionModelUnavailability(provider, connectionId, model);
    } else {
      removed = clearModelUnavailability(provider, model);
    }
    return NextResponse.json({ ok: true, removed });
  } catch (error: unknown) {
    console.error("[API] DELETE /api/resilience/model-cooldowns error:", error);
    return NextResponse.json(
      { error: getErrorMessage(error, "Failed to clear cooldown") },
      { status: 500 }
    );
  }
}
