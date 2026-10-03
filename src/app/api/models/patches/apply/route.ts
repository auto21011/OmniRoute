import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { syncPatchesToDatabase } from "@/lib/models/modelPatches";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const result = await syncPatchesToDatabase();
    return NextResponse.json({
      success: true,
      capabilitiesCount: result.capabilitiesCount,
      syncedAvailableModelsUpdated: result.syncedAvailableModelsUpdated,
      message: `Applied ${result.capabilitiesCount} model capabilities and updated ${result.syncedAvailableModelsUpdated} synced model entries in database.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sync model patches to database";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
