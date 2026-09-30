// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// next-intl: return the key so we can assert on stable strings. When options are
// passed, append their JSON so interpolated values (e.g. the degraded banner's
// `sources`) leave a distinctive trace the test can assert on.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, any>) =>
    opts ? `${key}${JSON.stringify(opts)}` : key,
  getTranslations: async () => (key: string, opts?: Record<string, any>) =>
    opts ? `${key}${JSON.stringify(opts)}` : key,
}));

// Shared type contract fixture (mirrors the API response shape).
function makeResponse(
  overrides: Partial<{
    connections: unknown[];
    breakers: unknown[];
    degraded: string[];
    coolingDownCount: number;
    unhealthyBreakerCount: number;
  }> = {}
) {
  return {
    connections: overrides.connections ?? [],
    breakers: overrides.breakers ?? [],
    window: { sinceMs: 0, untilMs: Date.now(), now: Date.now() },
    receivedAt: Date.now(),
    meta: {
      totalConnections: 0,
      coolingDownCount: overrides.coolingDownCount ?? 0,
      unhealthyBreakerCount: overrides.unhealthyBreakerCount ?? 0,
      countsCapped: false,
      degraded: overrides.degraded ?? [],
    },
  };
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1234567890",
    provider: "openai",
    name: "test-key",
    authType: "api_key",
    priority: 1,
    isActive: true,
    connectionStatus: "healthy",
    rateLimitedUntil: null,
    backoffLevel: 0,
    testStatus: null,
    lastErrorType: null,
    lastErrorAt: null,
    errorCode: null,
    lastUsedAt: null,
    cooldownRemainingMs: 0,
    isCoolingDown: false,
    breaker: { state: "CLOSED", failureCount: 0, retryAfterMs: 0, lastFailureKind: null },
    lockouts: [],
    ...overrides,
  };
}

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function render(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(node);
  });
  containers.push({ root, el });
  return el;
}

// Timer-api-aware wait: works with both fake and real timers.
// Flushes microtasks + React state on each tick, advancing fake timers when active.
async function waitFor(fn: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await act(async () => {
      // Flush microtasks so resolved fetch promises apply their state updates.
      await Promise.resolve();
      await Promise.resolve();
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(50);
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
    });
  }
}

describe("ResilienceConnectionsClient", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchMock.mockRestore();
    for (const { root, el } of containers) {
      act(() => {
        root.unmount();
      });
      el.remove();
    }
    containers.length = 0;
  });

  it("renders children from mock fetch", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({ connections: [makeConnection()] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("openai"));
    expect(el!.textContent).toContain("openai");
  });

  it("fetch uses cache: no-store", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({ connections: [makeConnection()] });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(resp), { status: 200 }));
    act(() => {
      render(<Client />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/resilience/connections"),
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("polling uses 30s interval", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({ connections: [makeConnection()] });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(resp), { status: 200 }));
    act(() => {
      render(<Client />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("404/403 stops poll permanently + renders pollError banner", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("pollErrorStopped"));
    const callsAfterStop = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    // No new fetches after 404.
    expect(fetchMock.mock.calls.length).toBe(callsAfterStop);
  });

  it("first-load 5xx renders pollError banner (not empty state)", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("pollErrorTransient"));
    expect(el!.textContent).not.toContain("No connections");
  });

  it("network error (fetch throw) renders pollError banner", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("pollErrorTransient"));
  });

  it("degradation banner shown when meta.degraded is non-empty", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({ connections: [makeConnection()], degraded: ["circuitBreaker"] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    // The degraded banner is the only caller passing a `sources` option, so the
    // interpolated JSON is a distinctive marker that the banner rendered.
    await waitFor(() => el!.textContent?.includes('"sources":"degraded.source.circuitBreaker"'));
  });

  it("degradation banner hidden when meta.degraded is empty", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({ connections: [makeConnection()], degraded: [] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("openai"));
    expect(el!.textContent).not.toContain('"sources"');
  });

  it("renders clear all cooldowns button when coolingDownCount > 0 and calls POST /api/resilience/connections", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({
      connections: [makeConnection({ isCoolingDown: true, connectionStatus: "cooling_down" })],
      coolingDownCount: 1,
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("summary.clearAllCooldowns"));
    const clearAllBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "summary.clearAllCooldowns"
    );
    expect(clearAllBtn).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, releasedCount: 1 }), { status: 200 })
    );

    act(() => {
      clearAllBtn!.click();
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/resilience/connections" && (c[1] as any)?.method === "POST"
      )
    );
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/resilience/connections" && (c[1] as any)?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as any).body)).toEqual({ all: true });
  });
});

describe("ConnectionsTable", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
    for (const { root, el } of containers) {
      act(() => {
        root.unmount();
      });
      el.remove();
    }
    containers.length = 0;
  });

  it("renders rows from props (no independent fetch)", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection();
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} />
      ) as HTMLDivElement;
    });
    expect(el!.textContent).toContain("openai");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("status badge shows correct variant for cooling_down", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection({ connectionStatus: "cooling_down" });
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} />
      ) as HTMLDivElement;
    });
    expect(el!.textContent).toContain("table.coolingDown");
  });

  it("status badge handles breaker={null} without crashing (optional chaining)", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection({ breaker: null });
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} />
      ) as HTMLDivElement;
    });
    // Healthy + null breaker -> "Healthy" badge (no crash).
    expect(el!.textContent).toContain("table.healthy");
  });

  it("cooldown countdown renders '-' for healthy connection", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection({ isCoolingDown: false });
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} />
      ) as HTMLDivElement;
    });
    expect(el!.textContent).toContain("-");
  });

  it("empty state renders when no connections", async () => {
    const { default: Client } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ResilienceConnectionsClient");
    const resp = makeResponse({ connections: [] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));
    let el: HTMLDivElement;
    act(() => {
      el = render(<Client />) as HTMLDivElement;
    });
    await waitFor(() => el!.textContent?.includes("empty.title"));
  });

  it("row click opens ConnectionDetail with breaker + lockouts", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection({
      breaker: { state: "OPEN", failureCount: 3, retryAfterMs: 60000, lastFailureKind: "timeout" },
      lockouts: [{ model: "gpt-4", reason: "rate_limit", remainingMs: 30000 }],
    });
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} />
      ) as HTMLDivElement;
    });
    // Click the row to open detail.
    const row = el!.querySelector("tbody tr") as HTMLTableRowElement;
    expect(row).toBeTruthy();
    act(() => {
      row.click();
    });
    await waitFor(() => el!.textContent?.includes("detail.title"));
    expect(el!.textContent).toContain("OPEN");
    expect(el!.textContent).toContain("gpt-4");
  });

  it("selected connection deleted -> ConnectionDetail closes gracefully", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection();
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} />
      ) as HTMLDivElement;
    });
    const root = containers[containers.length - 1].root;
    const row = el!.querySelector("tbody tr") as HTMLTableRowElement;
    act(() => {
      row.click();
    });
    await waitFor(() => el!.textContent?.includes("detail.title"));
    // Re-render with the connection removed.
    act(() => {
      root.render(<Table connections={[]} receivedAt={Date.now()} degraded={[]} />);
    });
    await waitFor(() => !el!.textContent?.includes("detail.title"));
    expect(el!.textContent).not.toContain("detail.title");
  });

  it("releases lockout in ConnectionDetail on button click", async () => {
    const { default: ConnectionDetail } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionDetail");
    const conn = makeConnection({
      id: "conn-detail-1",
      provider: "openai",
      lockouts: [{ model: "gpt-4", reason: "manual_disable", remainingMs: 30000 }],
    });

    let el: HTMLDivElement;
    act(() => {
      el = render(
        <ConnectionDetail connection={conn} receivedAt={Date.now()} onClose={() => {}} />
      ) as HTMLDivElement;
    });

    expect(el!.textContent).toContain("gpt-4");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 })
    );

    const releaseBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "detail.release"
    );
    expect(releaseBtn).toBeTruthy();

    act(() => {
      releaseBtn!.click();
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/resilience/model-cooldowns" && (c[1] as any)?.method === "DELETE"
      )
    );
    const deleteCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/resilience/model-cooldowns" && (c[1] as any)?.method === "DELETE"
    );
    expect(deleteCall).toBeTruthy();
    expect(JSON.parse((deleteCall![1] as any).body)).toEqual({
      provider: "openai",
      model: "gpt-4",
      connectionId: "conn-detail-1",
    });
  });

  it("renders clear cooldown button on cooling down connection and calls POST /api/resilience/connections", async () => {
    const { default: Table } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionsTable");
    const conn = makeConnection({
      id: "conn-cool-1",
      provider: "sensenova",
      isCoolingDown: true,
      connectionStatus: "cooling_down",
    });
    const onRefresh = vi.fn();
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Table connections={[conn]} receivedAt={Date.now()} degraded={[]} onRefresh={onRefresh} />
      ) as HTMLDivElement;
    });
    const clearBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "table.clearCooldown"
    );
    expect(clearBtn).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, releasedCount: 1 }), { status: 200 })
    );

    act(() => {
      clearBtn!.click();
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/resilience/connections" && (c[1] as any)?.method === "POST"
      )
    );
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/resilience/connections" && (c[1] as any)?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as any).body)).toEqual({
      connectionId: "conn-cool-1",
      provider: "sensenova",
      resetBreaker: true,
      clearLockouts: true,
    });
    await waitFor(() => onRefresh.mock.calls.length > 0);
  });

  it("renders clear cooldown and restore buttons in ConnectionDetail", async () => {
    const { default: ConnectionDetail } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionDetail");
    const conn = makeConnection({
      id: "conn-detail-cool",
      provider: "sensenova",
      isCoolingDown: true,
      rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
      breaker: {
        state: "OPEN",
        failureCount: 5,
        retryAfterMs: 30000,
        lastFailureKind: "rate_limit",
      },
    });
    const onRefresh = vi.fn();
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <ConnectionDetail
          connection={conn}
          receivedAt={Date.now()}
          onClose={() => {}}
          onRefresh={onRefresh}
        />
      ) as HTMLDivElement;
    });

    const clearCooldownBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "detail.clearCooldown"
    );
    expect(clearCooldownBtn).toBeTruthy();

    const resetBreakerBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "detail.resetBreaker"
    );
    expect(resetBreakerBtn).toBeTruthy();

    const restoreBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "detail.restoreConnection"
    );
    expect(restoreBtn).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, releasedCount: 1 }), { status: 200 })
    );

    act(() => {
      clearCooldownBtn!.click();
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/resilience/connections" && (c[1] as any)?.method === "POST"
      )
    );
    await waitFor(() => onRefresh.mock.calls.length > 0);
  });
});

describe("ConnectionDetail advanced operations", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
    for (const { root, el } of containers) {
      act(() => {
        root.unmount();
      });
      el.remove();
    }
    containers.length = 0;
  });

  it("submits disable model form calling POST /api/resilience/model-cooldowns via select", async () => {
    const { default: ConnectionDetail } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionDetail");
    const conn = makeConnection({
      id: "conn-lock-1",
      provider: "anthropic",
      lockouts: [],
    });
    const onRefresh = vi.fn();

    let el: HTMLDivElement;
    act(() => {
      el = render(
        <ConnectionDetail
          connection={conn}
          receivedAt={Date.now()}
          onClose={() => {}}
          onRefresh={onRefresh}
        />
      ) as HTMLDivElement;
    });

    const disableBtn = Array.from(el!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("detail.disableModel")
    );
    expect(disableBtn).toBeTruthy();

    act(() => {
      disableBtn!.click();
    });

    const select = el!.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();

    act(() => {
      select.value = "claude-sonnet-4.5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, lockedCount: 1, until: Date.now() + 300000 }), {
        status: 200,
      })
    );

    const form = el!.querySelector("form");
    expect(form).toBeTruthy();

    act(() => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/resilience/model-cooldowns" && (c[1] as any)?.method === "POST"
      )
    );
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/resilience/model-cooldowns" && (c[1] as any)?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as any).body)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      durationMs: 300000,
      connectionId: "conn-lock-1",
      scope: "connection",
      reason: "manual_disable",
    });
    await waitFor(() => onRefresh.mock.calls.length > 0);
  });

  it("submits disable model form with custom input when choosing custom option", async () => {
    const { default: ConnectionDetail } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionDetail");
    const conn = makeConnection({
      id: "conn-lock-2",
      provider: "anthropic",
      lockouts: [],
    });
    const onRefresh = vi.fn();

    let el: HTMLDivElement;
    act(() => {
      el = render(
        <ConnectionDetail
          connection={conn}
          receivedAt={Date.now()}
          onClose={() => {}}
          onRefresh={onRefresh}
        />
      ) as HTMLDivElement;
    });

    const disableBtn = Array.from(el!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("detail.disableModel")
    );
    expect(disableBtn).toBeTruthy();

    act(() => {
      disableBtn!.click();
    });

    const select = el!.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();

    act(() => {
      select.value = "__custom__";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const input = el!.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "claude-custom-special");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, lockedCount: 1, until: Date.now() + 300000 }), {
        status: 200,
      })
    );

    const form = el!.querySelector("form");
    expect(form).toBeTruthy();

    act(() => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/resilience/model-cooldowns" && (c[1] as any)?.method === "POST"
      )
    );
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/resilience/model-cooldowns" && (c[1] as any)?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as any).body)).toEqual({
      provider: "anthropic",
      model: "claude-custom-special",
      durationMs: 300000,
      connectionId: "conn-lock-2",
      scope: "connection",
      reason: "manual_disable",
    });
    await waitFor(() => onRefresh.mock.calls.length > 0);
  });

  it("submits manual cooldown and trip breaker in ConnectionDetail", async () => {
    const { default: ConnectionDetail } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionDetail");
    const conn = makeConnection({
      id: "conn-healthy-1",
      provider: "openai",
      isCoolingDown: false,
      breaker: {
        state: "CLOSED",
        failureCount: 0,
        retryAfterMs: 0,
        lastFailureKind: null,
      },
    });
    const onRefresh = vi.fn();

    let el: HTMLDivElement;
    act(() => {
      el = render(
        <ConnectionDetail
          connection={conn}
          receivedAt={Date.now()}
          onClose={() => {}}
          onRefresh={onRefresh}
        />
      ) as HTMLDivElement;
    });

    // 1. Manual cooldown
    const cooldownBtn = Array.from(el!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("detail.manualCooldown")
    );
    expect(cooldownBtn).toBeTruthy();

    act(() => {
      cooldownBtn!.click();
    });

    const confirmCooldownBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "detail.confirmCooldown"
    );
    expect(confirmCooldownBtn).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, connectionId: "conn-healthy-1" }), { status: 200 })
    );

    act(() => {
      confirmCooldownBtn!.click();
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) =>
          c[0] === "/api/resilience/connections" &&
          (c[1] as any)?.method === "POST" &&
          JSON.parse((c[1] as any).body).action === "set_cooldown"
      )
    );

    // 2. Manual trip breaker
    const tripBtn = Array.from(el!.querySelectorAll("button")).find(
      (b) => b.textContent === "detail.manualTrip"
    );
    expect(tripBtn).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, tripped: true }), { status: 200 })
    );

    act(() => {
      tripBtn!.click();
    });

    await waitFor(() =>
      fetchMock.mock.calls.some(
        (c) =>
          c[0] === "/api/resilience/connections" &&
          (c[1] as any)?.method === "POST" &&
          JSON.parse((c[1] as any).body).action === "trip_breaker"
      )
    );
  });

  it("includes imported models and excludes hidden models from provider model selection", async () => {
    (globalThis as any).__TEST_ENABLE_MODEL_FETCH__ = true;
    try {
      const { default: ConnectionDetail } =
        await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/ConnectionDetail");
      const conn = makeConnection({
        id: "conn-sensenova-1",
        provider: "sensenova",
        lockouts: [],
      });

      fetchMock.mockImplementation((url) => {
        const u = String(url);
        if (u.includes("/api/provider-models")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [
                  {
                    id: "sensenova-custom-imported",
                    name: "SenseNova Imported Custom",
                    source: "imported",
                  },
                  {
                    id: "sensenova-hidden-imported",
                    name: "SenseNova Hidden",
                    source: "imported",
                    isHidden: true,
                  },
                ],
                modelCompatOverrides: [
                  { modelId: "deepseek-v4-flash", isHidden: true },
                  { id: "sensenova-6.7-flash-lite", isHidden: true },
                  { id: "compat-scoped-hidden", hiddenModalities: { chat: true } },
                ],
                hiddenModelsByProvider: {
                  sensenova: ["deepseek-v4-flash", "sensenova-hidden-imported"],
                },
              }),
              { status: 200 }
            )
          );
        }
        if (u.includes("/api/synced-available-models")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                providerId: "sensenova",
                models: [
                  { id: "sensenova-synced-1", name: "SenseNova Synced" },
                  { id: "compat-scoped-hidden", name: "Scoped Hidden" },
                ],
                authoritative: false,
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      });

      let el: HTMLDivElement;
      act(() => {
        el = render(
          <ConnectionDetail connection={conn} receivedAt={Date.now()} onClose={() => {}} />
        ) as HTMLDivElement;
      });

      const disableBtn = Array.from(el!.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("detail.disableModel")
      );
      expect(disableBtn).toBeTruthy();

      act(() => {
        disableBtn!.click();
      });

      await waitFor(() => {
        const options = Array.from(el!.querySelectorAll("select option")).map(
          (o) => (o as HTMLOptionElement).value
        );
        return options.includes("sensenova-custom-imported");
      });

      const options = Array.from(el!.querySelectorAll("select option")).map(
        (o) => (o as HTMLOptionElement).value
      );

      // Imported model MUST be present
      expect(options).toContain("sensenova-custom-imported");
      // Synced model MUST be present
      expect(options).toContain("sensenova-synced-1");
      // Non-hidden static model MUST be present
      expect(options).toContain("glm-5.2");

      // Hidden static model via modelCompatOverrides (with .id property) MUST NOT be present
      expect(options).not.toContain("sensenova-6.7-flash-lite");
      // Hidden model via hiddenModalities.chat MUST NOT be present
      expect(options).not.toContain("compat-scoped-hidden");
      // Hidden static model via modelCompatOverrides (with .modelId property) MUST NOT be present
      expect(options).not.toContain("deepseek-v4-flash");
      // Hidden imported model MUST NOT be present
      expect(options).not.toContain("sensenova-hidden-imported");
    } finally {
      delete (globalThis as any).__TEST_ENABLE_MODEL_FETCH__;
    }
  });
});

describe("BreakerTimeline", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
    for (const { root, el } of containers) {
      act(() => {
        root.unmount();
      });
      el.remove();
    }
    containers.length = 0;
  });

  it("renders transitions from props, window selector calls onWindowChange (NO self-fetch)", async () => {
    const { default: Timeline } =
      await import("../../../src/app/(dashboard)/dashboard/resilience/connections/components/BreakerTimeline");
    const breakers = [
      {
        name: "openai",
        state: "CLOSED",
        failureCount: 0,
        retryAfterMs: 0,
        lastFailureKind: null,
        transitionHistory: [
          {
            timestamp: Date.now() - 1000,
            from: "CLOSED",
            to: "OPEN",
            reason: "timeout-elapsed",
          },
        ],
      },
    ];
    const onWindowChange = vi.fn();
    let el: HTMLDivElement;
    act(() => {
      el = render(
        <Timeline breakers={breakers} onWindowChange={onWindowChange} />
      ) as HTMLDivElement;
    });
    expect(el!.textContent).toContain("openai");
    // Click the 6h window button.
    const buttons = Array.from(el!.querySelectorAll("button"));
    const sixHour = buttons.find((b) => b.textContent === "timeline.window6h");
    expect(sixHour).toBeTruthy();
    act(() => {
      sixHour!.click();
    });
    expect(onWindowChange).toHaveBeenCalledWith(21600000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("i18n", () => {
  it("sidebar i18n keys exist in both namespaces", async () => {
    const en = JSON.parse(
      require("fs").readFileSync(
        require("path").resolve(__dirname, "../../../src/i18n/messages/en.json"),
        "utf8"
      )
    );
    expect(en.sidebar.resilienceConnections).toBe("Connection Resilience");
    expect(en.sidebar.resilienceConnectionsSubtitle).toBe("Cooldown, breaker, lockout state");
    expect(en.resilienceConnections.title).toBe("Connection Resilience");
  });
});
