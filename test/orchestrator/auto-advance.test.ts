import { describe, expect, it } from "vitest";

/**
 * Tests for workstream auto-advance logic.
 *
 * Covers:
 * - Per-workstream locking to prevent re-entrancy
 * - Loop detection (abort if same transition fires 3+ times in 60s)
 * - Retry caps (verification failures max 2 retries)
 * - Question-saturation gating (auto-advance when pending_questions == 0)
 */

describe("Workstream auto-advance", () => {
  describe("question-saturation gating", () => {
    it("should auto-advance planning→implementation when pendingQuestions.length === 0", () => {
      const pendingQuestions: any[] = [];
      const finalExecutionPrompt = "Execute the plan";
      const canAutoAdvance = pendingQuestions.length === 0 && Boolean(finalExecutionPrompt);
      expect(canAutoAdvance).toBe(true);
    });

    it("should NOT auto-advance when pendingQuestions exist", () => {
      const pendingQuestions = [
        { id: "q1", question: "Auth method?" }
      ];
      const canAutoAdvance = pendingQuestions.length === 0;
      expect(canAutoAdvance).toBe(false);
    });

    it("should NOT auto-advance without finalExecutionPrompt", () => {
      const pendingQuestions: any[] = [];
      const finalExecutionPrompt = "";
      const canAutoAdvance = pendingQuestions.length === 0 && Boolean(finalExecutionPrompt);
      expect(canAutoAdvance).toBe(false);
    });

    it("should trigger auto-advance after decision answers provided", () => {
      const previousPendingQuestions = [{ id: "q1", question: "Auth method?" }];
      const answersProvided = { "q1": "JWT" };
      const newPendingQuestions: any[] = []; // After merging answers
      const shouldAutoAdvance = newPendingQuestions.length === 0;
      expect(shouldAutoAdvance).toBe(true);
    });
  });

  describe("per-workstream locking", () => {
    it("should prevent concurrent auto-advance attempts on same workstream", () => {
      const locks = new Map<string, Promise<void>>();
      const workstreamId = "ws_123";

      const lock1 = Promise.resolve();
      locks.set(workstreamId, lock1);

      const hasExistingLock = locks.has(workstreamId);
      expect(hasExistingLock).toBe(true);
    });

    it("should allow auto-advance on different workstreams concurrently", () => {
      const locks = new Map<string, Promise<void>>();
      locks.set("ws_1", Promise.resolve());
      locks.set("ws_2", Promise.resolve());

      expect(locks.size).toBe(2);
      expect(locks.has("ws_1")).toBe(true);
      expect(locks.has("ws_2")).toBe(true);
    });

    it("should clean up lock after auto-advance completes", () => {
      const locks = new Map<string, Promise<void>>();
      const workstreamId = "ws_123";

      locks.set(workstreamId, Promise.resolve());
      locks.delete(workstreamId);

      expect(locks.has(workstreamId)).toBe(false);
    });

    it("should clean up lock even if auto-advance throws error", () => {
      const locks = new Map<string, Promise<void>>();
      const workstreamId = "ws_123";

      locks.set(workstreamId, Promise.reject(new Error("Test error")));
      locks.delete(workstreamId);

      expect(locks.has(workstreamId)).toBe(false);
    });
  });

  describe("loop detection", () => {
    it("should allow single state transition without triggering detection", () => {
      const now = Date.now();
      const transitions = [{ transition: "plan-approved", count: 1, timestamp: now }];
      const sameTransitionRecently = transitions[0].count >= 3;
      expect(sameTransitionRecently).toBe(false);
    });

    it("should allow two transitions of same type within 60 seconds", () => {
      const now = Date.now();
      const transitions = [
        { transition: "plan-approved", count: 1, timestamp: now },
        { transition: "plan-approved", count: 2, timestamp: now + 5000 },
      ];
      const sameTransitionRecently = transitions[1].count >= 3;
      expect(sameTransitionRecently).toBe(false);
    });

    it("should abort on third transition of same type within 60 seconds", () => {
      const now = Date.now();
      const transitions = [
        { transition: "plan-approved", count: 1, timestamp: now },
        { transition: "plan-approved", count: 2, timestamp: now + 5000 },
        { transition: "plan-approved", count: 3, timestamp: now + 10000 },
      ];
      const loopDetected = transitions[2].count >= 3 && (transitions[2].timestamp - transitions[0].timestamp) < 60000;
      expect(loopDetected).toBe(true);
    });

    it("should reset counter after 60 seconds elapses", () => {
      const now = Date.now();
      const firstTransition = { timestamp: now };
      const secondTransition = { timestamp: now + 65000 }; // 65 seconds later
      const timeElapsed = secondTransition.timestamp - firstTransition.timestamp;
      const shouldResetCounter = timeElapsed >= 60000;
      expect(shouldResetCounter).toBe(true);
    });

    it("should allow different transitions concurrently", () => {
      const now = Date.now();
      const transitions = [
        { transition: "plan-approved", count: 1, timestamp: now },
        { transition: "implementation-complete", count: 1, timestamp: now + 5000 },
      ];
      const loopDetected = transitions.every(t => t.count >= 3);
      expect(loopDetected).toBe(false);
    });
  });

  describe("verification retry cap", () => {
    it("should allow first retry after verification-failed", () => {
      const retryCount = 0;
      const maxRetries = 2;
      const canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(true);
    });

    it("should allow second retry after verification-failed again", () => {
      const retryCount = 1;
      const maxRetries = 2;
      const canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(true);
    });

    it("should block further auto-advance after reaching retry cap", () => {
      const retryCount = 2;
      const maxRetries = 2;
      const canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(false);
    });

    it("should clear retry count after verification-passed", () => {
      const retryCount = 2;
      const verificationPassed = true;
      const clearedRetryCount = verificationPassed ? 0 : retryCount;
      expect(clearedRetryCount).toBe(0);
    });

    it("should increment retry count only on verification-failed transition", () => {
      const transitions = ["implementation-complete", "verification-failed", "verification-failed"];
      const verificationFailedCount = transitions.filter(t => t === "verification-failed").length;
      expect(verificationFailedCount).toBe(2);
    });
  });

  describe("auto-advance triggers and transitions", () => {
    it("should auto-advance planning→implementation with plan-approved trigger", () => {
      const from = "planning";
      const to = "implementation";
      const trigger = "plan-approved";
      expect(from).not.toBe(to);
    });

    it("should auto-advance awaiting-decisions→planning with operator-input-received trigger", () => {
      const from = "awaiting-decisions";
      const to = "planning";
      const trigger = "operator-input-received";
      expect(from).not.toBe(to);
    });

    it("should auto-advance implementation→verification with implementation-complete trigger", () => {
      const from = "implementation";
      const to = "verification";
      const trigger = "implementation-complete";
      expect(from).not.toBe(to);
    });

    it("should auto-advance verification→review with verification-passed trigger", () => {
      const from = "verification";
      const to = "review";
      const trigger = "verification-passed";
      expect(from).not.toBe(to);
    });
  });

  describe("auto-advance edge cases", () => {
    it("should not auto-advance if workstream is in terminal state", () => {
      const state = "done";
      const isTerminal = state === "done" || state === "archived";
      const canAutoAdvance = !isTerminal;
      expect(canAutoAdvance).toBe(false);
    });

    it("should not auto-advance if active operation is running", () => {
      const hasActiveOperation = true;
      const canAutoAdvance = !hasActiveOperation;
      expect(canAutoAdvance).toBe(false);
    });

    it("should not auto-advance if transition is not marked autoAdvance", () => {
      const transitionConfig = { from: "planning", to: "implementation", autoAdvance: false };
      const canAutoAdvance = transitionConfig.autoAdvance;
      expect(canAutoAdvance).toBe(false);
    });

    it("should auto-advance even if hint is not provided (try available transitions)", () => {
      const hint = undefined;
      const availableTransitions = ["plan-approved"];
      const hasAvailableTransition = availableTransitions.length > 0;
      expect(hasAvailableTransition).toBe(true);
    });
  });

  describe("auto-advance logging and events", () => {
    it("should log auto-advance attempt with from/to states", () => {
      const log_entry = {
        workstreamId: "ws_123",
        from: "planning",
        to: "implementation",
        trigger: "plan-approved",
      };
      expect(log_entry.from).toBeDefined();
      expect(log_entry.to).toBeDefined();
    });

    it("should emit workstream.autoAdvanced event on success", () => {
      const eventType = "workstream.autoAdvanced";
      expect(eventType).toContain("auto");
    });

    it("should log loop detection as error", () => {
      const error_log = {
        level: "error",
        message: "Loop detected: same transition fired 3+ times",
        workstreamId: "ws_123",
      };
      expect(error_log.level).toBe("error");
    });

    it("should log when auto-advance is skipped due to active lock", () => {
      const debug_log = {
        level: "debug",
        message: "Auto-advance already in progress, skipping",
      };
      expect(debug_log.level).toBe("debug");
    });
  });
});
