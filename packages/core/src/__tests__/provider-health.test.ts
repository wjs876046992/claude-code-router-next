import { describe, it, expect, beforeEach } from "vitest";
import { ProviderHealthStore } from "../services/provider-health";

describe("ProviderHealthStore", () => {
  let store: ProviderHealthStore;

  beforeEach(() => {
    store = new ProviderHealthStore({ enabled: true });
  });

  // --- Empty provider/model guards (consolidated in getKey) ---

  describe("empty provider/model guards", () => {
    it("recordSuccess should be a no-op with empty provider", () => {
      store.recordSuccess("", "model-a");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("recordSuccess should be a no-op with empty model", () => {
      store.recordSuccess("provider-a", "");
      expect(store.getState("provider-a", "")).toBeUndefined();
    });

    it("recordFailure should be a no-op with empty provider", () => {
      store.recordFailure("", "model-a", "err");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("recordFailure should be a no-op with empty model", () => {
      store.recordFailure("provider-a", "", "err");
      expect(store.getState("provider-a", "")).toBeUndefined();
    });

    it("isAvailable should return false with empty provider", () => {
      expect(store.isAvailable("", "model-a")).toBe(false);
    });

    it("isAvailable should return false with empty model", () => {
      expect(store.isAvailable("provider-a", "")).toBe(false);
    });

    it("getState should return undefined with empty provider", () => {
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("getState should return undefined with empty model", () => {
      expect(store.getState("provider-a", "")).toBeUndefined();
    });

    it("getPriority should return 2 (worst) with empty provider", () => {
      expect(store.getPriority("", "model-a")).toBe(2);
    });

    it("getPriority should return 2 (worst) with empty model", () => {
      expect(store.getPriority("provider-a", "")).toBe(2);
    });

    it("forceOpen should be a no-op with empty provider", () => {
      store.forceOpen("", "model-a");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("markRateLimited should be a no-op with empty provider", () => {
      store.markRateLimited("", "model-a");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("recover should be a no-op with empty provider", () => {
      // Should not throw
      store.recover("", "model-a");
    });

    it("restore should skip entries with empty provider", () => {
      store.restore({
        provider: "",
        model: "model-a",
        status: "open",
        failureCount: 3,
        successCount: 0,
        lastFailureTime: Date.now(),
        lastProbeTime: 0,
      });
      expect(store.getAllStates()).toHaveLength(0);
    });

    it("markProbeAttempt should be a no-op with empty provider", () => {
      // Should not throw
      store.markProbeAttempt("", "model-a");
    });
  });

  // --- Normal operation (ensure guards don't break valid inputs) ---

  describe("normal operation", () => {
    it("recordFailure should track state for valid provider/model", () => {
      store.recordFailure("provider-a", "model-a", "timeout");
      const state = store.getState("provider-a", "model-a");
      expect(state).toBeDefined();
      expect(state!.failureCount).toBe(1);
      expect(state!.status).toBe("closed");
    });

    it("recordFailure should transition to open after threshold", () => {
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      const state = store.getState("provider-a", "model-a");
      expect(state!.status).toBe("open");
    });

    it("isAvailable should return true for healthy models", () => {
      expect(store.isAvailable("provider-a", "model-a")).toBe(true);
    });

    it("isAvailable should return false for open (failed) models", () => {
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      expect(store.isAvailable("provider-a", "model-a")).toBe(false);
    });

    it("forceOpen should mark model as unavailable immediately", () => {
      store.forceOpen("provider-a", "model-a", "manual");
      expect(store.isAvailable("provider-a", "model-a")).toBe(false);
    });

    it("recordSuccess should recover half-open model", () => {
      store.forceOpen("provider-a", "model-a");
      // Manually set to half-open
      const state = store.getState("provider-a", "model-a")!;
      state.status = "half-open";
      state.successCount = 0;

      store.recordSuccess("provider-a", "model-a");
      store.recordSuccess("provider-a", "model-a");
      expect(store.getState("provider-a", "model-a")).toBeUndefined(); // deleted = fully recovered
    });
  });
});
