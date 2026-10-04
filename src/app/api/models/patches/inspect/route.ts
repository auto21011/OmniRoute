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
    let realCatalogEntry: Record<string, unknown> | null = null;
    try {
      const { getUnifiedModelsResponse } = await import("@/app/api/v1/models/catalog");
      const { findModelById } = await import("@/app/api/v1/models/modelById");

      const listResp = await getUnifiedModelsResponse(new Request("http://localhost/v1/models"));
      if (listResp && listResp.ok) {
        const listData = (await listResp.json()) as { data?: Array<Record<string, unknown>> };
        if (Array.isArray(listData?.data)) {
          const prov = parsed.data.provider;
          const mod = parsed.data.modelId;
          const found =
            findModelById(listData.data, mod) ||
            (prov ? findModelById(listData.data, `${prov}/${mod}`) : null) ||
            findModelById(
              listData.data,
              mod.includes("/") ? mod.split("/").slice(1).join("/") : mod
            );

          if (found) {
            realCatalogEntry = found;
          }
        }
      }
    } catch {
      // Gracefully fallback to simulated catalog entry
    }

    const result = await inspectModelPatch(
      parsed.data.provider,
      parsed.data.modelId,
      undefined,
      realCatalogEntry
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to inspect model patch";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
