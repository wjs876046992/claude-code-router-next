import { describe, it, expect, beforeEach } from "vitest";
import {
  routeWithConcurrencyPriority,
  rebindSessionModel,
  releaseRequestLease,
  acquireRequestLease,
  getConcurrencyTracker,
  getSessionBindingStore,
  getRequestSlotKey,
  resetConcurrencyPriorityState,
  DEFAULT_CONCURRENCY_THRESHOLD,
} from "../utils/concurrency-router";

function makeReq(
  sessionId?: string,
  scenarioType: string = "default",
  modelFamily?: string
) {
  return {
    sessionId,
    scenarioType,
    modelFamily,
    clientContext: sessionId ? { stableSessionId: sessionId } : undefined,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any;
}

const identityResolve =
  (unavailable: string[] = []) =>
  (modelKey: string): string | null =>
    unavailable.includes(modelKey) ? null : modelKey;

describe("concurrency-router", () => {
  beforeEach(() => {
    resetConcurrencyPriorityState();
  });

  describe("fresh assignment", () => {
    it("assigns the selected model when below the threshold", () => {
      const req = makeReq("s1");
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(model).toBe("p,primary");
      expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBe(
        "p,primary"
      );
    });

    it("overflows a new session to the fallback list once the selected model reaches the threshold", () => {
      const tracker = getConcurrencyTracker();
      // Simulate 3 in-flight requests on the primary (threshold = 3).
      const l1 = tracker.acquire("p,primary");
      const l2 = tracker.acquire("p,primary");
      const l3 = tracker.acquire("p,primary");

      const req = makeReq("s-overflow");
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(model).toBe("f,fallback");
      expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBe(
        "f,fallback"
      );

      tracker.release(l1);
      tracker.release(l2);
      tracker.release(l3);
    });

    it("uses the default threshold of 3 when the configured value is invalid", () => {
      expect(DEFAULT_CONCURRENCY_THRESHOLD).toBe(3);
      const tracker = getConcurrencyTracker();
      const leases = [
        tracker.acquire("p,primary"),
        tracker.acquire("p,primary"),
        tracker.acquire("p,primary"),
      ];
      const req = makeReq("s-default-threshold");
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: NaN,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(model).toBe("f,fallback");
      leases.forEach((l) => tracker.release(l));
    });

    it("stays on the selected model when no fallback model is resolvable", () => {
      const tracker = getConcurrencyTracker();
      const leases = Array.from({ length: 5 }, () => tracker.acquire("p,primary"));
      const req = makeReq("s-no-fallback");
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,down"],
        resolve: identityResolve(["f,down"]),
      });
      expect(model).toBe("p,primary");
      expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBe(
        "p,primary"
      );
      leases.forEach((l) => tracker.release(l));
    });

    it("picks the least-loaded fallback model", () => {
      const tracker = getConcurrencyTracker();
      const leases = Array.from({ length: 4 }, () => tracker.acquire("p,primary"));
      // f1 already has one in-flight request; f2 has none.
      const fbLease = tracker.acquire("f1,m");
      const req = makeReq("s-least-loaded");
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f1,m", "f2,m"],
        resolve: identityResolve(),
      });
      expect(model).toBe("f2,m");
      leases.forEach((l) => tracker.release(l));
      tracker.release(fbLease);
    });

    it("breaks load ties by configured order", () => {
      const tracker = getConcurrencyTracker();
      const leases = Array.from({ length: 3 }, () => tracker.acquire("p,primary"));
      const req = makeReq("s-tie");
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f1,m", "f2,m"],
        resolve: identityResolve(),
      });
      // Equal load -> the first configured candidate wins (strict <).
      expect(model).toBe("f1,m");
      leases.forEach((l) => tracker.release(l));
    });

    it("overflows requests without a session id but never pins them", () => {
      const tracker = getConcurrencyTracker();
      const leases = Array.from({ length: 3 }, () => tracker.acquire("p,primary"));

      const req = makeReq(undefined); // no session id
      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(model).toBe("f,fallback");
      expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBeUndefined();

      // Lease-only rebind (error-fallback path) still transfers the lease.
      rebindSessionModel(req, "f,other");
      expect(getConcurrencyTracker().count("f,fallback")).toBe(0);
      expect(getConcurrencyTracker().count("f,other")).toBe(1);
      releaseRequestLease(req);
      expect(getConcurrencyTracker().count("f,other")).toBe(0);

      leases.forEach((l) => tracker.release(l));
    });
  });

  describe("session stickiness", () => {
    it("sticks a session to its bound model even when congestion clears", () => {
      const tracker = getConcurrencyTracker();
      const leases = Array.from({ length: 3 }, () => tracker.acquire("p,primary"));

      // First request overflows to the fallback.
      const req1 = makeReq("s-sticky");
      const first = routeWithConcurrencyPriority(req1, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(first).toBe("f,fallback");
      releaseRequestLease(req1);

      // Congestion clears.
      leases.forEach((l) => tracker.release(l));

      // Next request in the same session still goes to the bound fallback.
      const req2 = makeReq("s-sticky");
      const second = routeWithConcurrencyPriority(req2, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(second).toBe("f,fallback");
      releaseRequestLease(req2);
    });

    it("bindings are per scenario: think traffic does not stick to the default slot", () => {
      // Default slot bound to the primary.
      const reqDefault = makeReq("s-scenario", "default");
      routeWithConcurrencyPriority(reqDefault, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });

      // Think slot is a separate slot: fresh assignment, below threshold.
      const reqThink = makeReq("s-scenario", "think");
      const thinkModel = routeWithConcurrencyPriority(reqThink, "t,think", {
        threshold: 3,
        fallbackModels: ["f,thinkFallback"],
        resolve: identityResolve(),
      });
      expect(thinkModel).toBe("t,think");
      expect(getSessionBindingStore().get(getRequestSlotKey(reqThink))).toBe(
        "t,think"
      );
      expect(getSessionBindingStore().get(getRequestSlotKey(reqDefault))).toBe(
        "p,primary"
      );
      releaseRequestLease(reqDefault);
      releaseRequestLease(reqThink);
    });

    it("bindings are per model family within the same scenario", () => {
      // opus-family default slot bound to p1.
      const reqOpus = makeReq("s-family", "default", "opus");
      routeWithConcurrencyPriority(reqOpus, "p1,opus-default", {
        threshold: 3,
        fallbackModels: [],
        resolve: identityResolve(),
      });

      // sonnet-family default traffic is a different slot: fresh assignment.
      const reqSonnet = makeReq("s-family", "default", "sonnet");
      const model = routeWithConcurrencyPriority(reqSonnet, "p2,sonnet-default", {
        threshold: 3,
        fallbackModels: [],
        resolve: identityResolve(),
      });
      expect(model).toBe("p2,sonnet-default");
      releaseRequestLease(reqOpus);
      releaseRequestLease(reqSonnet);
    });

    it("re-assigns when the bound model becomes unavailable", () => {
      const store = getSessionBindingStore();
      const req = makeReq("s-gone");
      store.bind(getRequestSlotKey(req), "f,gone");

      const model = routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,gone"],
        resolve: identityResolve(["f,gone"]),
      });
      // Bound model unusable -> binding dropped, falls back to the selected model.
      expect(model).toBe("p,primary");
      expect(store.get(getRequestSlotKey(req))).toBe("p,primary");
      releaseRequestLease(req);
    });

    it("different sessions can be assigned to different providers", () => {
      const tracker = getConcurrencyTracker();
      const reqA = makeReq("session-a");
      const modelA = routeWithConcurrencyPriority(reqA, "p,primary", {
        threshold: 2,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(modelA).toBe("p,primary");

      // reqA holds a lease on the primary; add one more to reach threshold 2.
      const extra = tracker.acquire("p,primary");
      const reqB = makeReq("session-b");
      const modelB = routeWithConcurrencyPriority(reqB, "p,primary", {
        threshold: 2,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(modelB).toBe("f,fallback");

      releaseRequestLease(reqA);
      releaseRequestLease(reqB);
      tracker.release(extra);
    });
  });

  describe("rebindSessionModel (error fallback path)", () => {
    it("rebinds a participating session to the fallback model that succeeded", () => {
      const req = makeReq("s-rebind");
      routeWithConcurrencyPriority(req, "p,primary", {
        threshold: 3,
        fallbackModels: ["f,fallback"],
        resolve: identityResolve(),
      });
      expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBe(
        "p,primary"
      );

      rebindSessionModel(req, "f,fallback");
      expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBe(
        "f,fallback"
      );

      // The in-flight lease follows the new model.
      expect(getConcurrencyTracker().count("p,primary")).toBe(0);
      expect(getConcurrencyTracker().count("f,fallback")).toBe(1);
      releaseRequestLease(req);
      expect(getConcurrencyTracker().count("f,fallback")).toBe(0);
    });

    it("is a no-op for requests that never participated in concurrency routing", () => {
      const req = makeReq("s-not-participating");
      rebindSessionModel(req, "f,fallback");
      expect(
        getSessionBindingStore().get(getRequestSlotKey(req))
      ).toBeUndefined();
      expect(getConcurrencyTracker().count("f,fallback")).toBe(0);
    });
  });

  describe("lease accounting", () => {
    it("acquire is idempotent for the same key and transfers across keys", () => {
      const req = makeReq("s-lease");
      acquireRequestLease(req, "p,primary");
      acquireRequestLease(req, "p,primary");
      expect(getConcurrencyTracker().count("p,primary")).toBe(1);

      acquireRequestLease(req, "f,fallback");
      expect(getConcurrencyTracker().count("p,primary")).toBe(0);
      expect(getConcurrencyTracker().count("f,fallback")).toBe(1);

      releaseRequestLease(req);
      releaseRequestLease(req); // idempotent
      expect(getConcurrencyTracker().count("f,fallback")).toBe(0);
    });
  });
});
