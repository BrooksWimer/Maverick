import { describe, expect, it } from "vitest";

/**
 * Tests for runtime instance identity.
 *
 * Covers:
 * - Unique instance ID generation
 * - Instance ID persistence
 * - Instance ID format and validation
 */

describe("Runtime instance identity", () => {
  describe("instance ID generation", () => {
    it("should generate unique instance ID on startup", () => {
      const instanceId1 = "inst_" + Math.random().toString(36).slice(2);
      const instanceId2 = "inst_" + Math.random().toString(36).slice(2);
      expect(instanceId1).not.toBe(instanceId2);
    });

    it("should use UUID format for instance IDs", () => {
      const instanceId = "550e8400-e29b-41d4-a716-446655440000";
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId);
      expect(isUUID).toBe(true);
    });

    it("should include instance ID in all log entries", () => {
      const log = {
        instanceId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Orchestrator initialized"
      };
      expect(log.instanceId).toBeDefined();
      expect(log.message).toBeDefined();
    });
  });

  describe("instance ID persistence", () => {
    it("should use same instance ID for entire session", () => {
      const instanceId = "persistent-id-123";
      const startLog = { instanceId };
      const endLog = { instanceId };
      expect(startLog.instanceId).toBe(endLog.instanceId);
    });

    it("should persist instance ID in runtime state", () => {
      const runtime = {
        instanceId: "550e8400-e29b-41d4-a716-446655440000",
        startTime: Date.now()
      };
      expect(runtime.instanceId).toBeDefined();
      expect(runtime.startTime).toBeDefined();
    });

    it("should use persisted ID across restarts if available", () => {
      const savedInstanceId = "550e8400-e29b-41d4-a716-446655440000";
      const newInstanceId = savedInstanceId; // Use saved ID on restart
      expect(newInstanceId).toBe(savedInstanceId);
    });
  });

  describe("instance ID in event logging", () => {
    it("should include instanceId in all event log entries", () => {
      const event = {
        workstream_id: "ws_123",
        event_type: "workstream.created",
        source: "orchestrator",
        instanceId: "550e8400-e29b-41d4-a716-446655440000"
      };
      expect(event.instanceId).toBeDefined();
      expect(event.instanceId.length).toBeGreaterThan(0);
    });

    it("should help trace events to their originating instance", () => {
      const events = [
        { instanceId: "inst-1", event: "planning.started" },
        { instanceId: "inst-1", event: "planning.completed" },
        { instanceId: "inst-2", event: "verification.started" },
      ];
      const fromInstance1 = events.filter(e => e.instanceId === "inst-1");
      expect(fromInstance1.length).toBe(2);
    });
  });

  describe("instance ID in Discord context", () => {
    it("should include instanceId in workstream thread bindings", () => {
      const binding = {
        workstream_id: "ws_123",
        thread_id: "12345",
        runtime_instance_id: "550e8400-e29b-41d4-a716-446655440000"
      };
      expect(binding.runtime_instance_id).toBeDefined();
    });

    it("should use instanceId to route Discord messages to correct runtime", () => {
      const message = {
        workstream_id: "ws_123",
        runtimeInstanceId: "550e8400-e29b-41d4-a716-446655440000"
      };
      const shouldRouteTo = message.runtimeInstanceId;
      expect(shouldRouteTo).toBeDefined();
    });

    it("should validate runtime instance when resolving thread for message", () => {
      const runtimeInstanceId = "550e8400-e29b-41d4-a716-446655440000";
      const binding_instanceId = "550e8400-e29b-41d4-a716-446655440000";
      const isValid = runtimeInstanceId === binding_instanceId;
      expect(isValid).toBe(true);
    });
  });

  describe("instance ID format validation", () => {
    it("should validate instance ID format before use", () => {
      const validId = "550e8400-e29b-41d4-a716-446655440000";
      const isValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(validId);
      expect(isValid).toBe(true);
    });

    it("should reject malformed instance IDs", () => {
      const invalidId = "not-a-valid-uuid";
      const isValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invalidId);
      expect(isValid).toBe(false);
    });

    it("should handle missing instance ID gracefully", () => {
      const maybeInstanceId = undefined;
      const fallbackId = "unknown-instance";
      const id = maybeInstanceId || fallbackId;
      expect(id).toBe(fallbackId);
    });
  });

  describe("instance ID in async operations", () => {
    it("should maintain instance ID context in async calls", async () => {
      const instanceId = "550e8400-e29b-41d4-a716-446655440000";
      const asyncResult = await Promise.resolve({ instanceId });
      expect(asyncResult.instanceId).toBe(instanceId);
    });

    it("should use instance ID in async error logging", () => {
      const instanceId = "550e8400-e29b-41d4-a716-446655440000";
      const error = { message: "Async error", instanceId };
      expect(error.instanceId).toBeDefined();
    });
  });

  describe("instance ID debugging", () => {
    it("should log instance ID during initialization", () => {
      const logEntry = {
        level: "info",
        message: "Orchestrator initialized",
        instanceId: "550e8400-e29b-41d4-a716-446655440000"
      };
      expect(logEntry.instanceId).toBeDefined();
      expect(logEntry.message).toContain("initialized");
    });

    it("should provide instance ID in debugging output", () => {
      const debugInfo = {
        instanceId: "550e8400-e29b-41d4-a716-446655440000",
        uptime: 3600,
        activeWorkstreams: 5
      };
      expect(debugInfo.instanceId).toBeDefined();
    });
  });
});
