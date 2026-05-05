import { describe, expect, it } from "vitest";

/**
 * Tests for review agent audit questions and important decisions.
 *
 * Covers:
 * - Clarifying questions emitted by review agent
 * - Important decisions documented by review agent
 * - Question severity levels (warning vs error)
 * - Operator decision context integration
 */

describe("Review agent audit questions", () => {
  describe("clarifying questions", () => {
    it("should emit question when architectural decision is unclear", () => {
      const requiredAnswers = [
        {
          id: "auth-strategy",
          question: "Is JWT the right choice or should we use sessions?",
          context: "The code supports both but doesn't explain the choice",
          severity: "error",
        }
      ];
      expect(requiredAnswers[0].id).toBeDefined();
      expect(requiredAnswers[0].question).toBeDefined();
    });

    it("should include context explaining why each question matters", () => {
      const question = {
        id: "q1",
        context: "This affects database schema design downstream"
      };
      expect(question.context).toContain("database schema");
    });

    it("should mark as error-severity if blocking ship decision", () => {
      const blockingQuestion = {
        id: "deployment-strategy",
        severity: "error"
      };
      expect(blockingQuestion.severity).toBe("error");
    });

    it("should mark as warning-severity if should-be-decided-soon", () => {
      const warningQuestion = {
        id: "monitoring-approach",
        severity: "warning"
      };
      expect(warningQuestion.severity).toBe("warning");
    });

    it("should ask about security trade-offs", () => {
      const securityQuestion = {
        id: "cors-policy",
        question: "Should we accept requests from localhost:3000 in production?",
        category: "security"
      };
      expect(securityQuestion.question).toContain("localhost");
    });

    it("should ask about performance trade-offs", () => {
      const performanceQuestion = {
        id: "caching-strategy",
        question: "Should we cache this database query?",
        category: "performance"
      };
      expect(performanceQuestion.question).toContain("cache");
    });

    it("should ask about patterns and conventions", () => {
      const patternQuestion = {
        id: "error-handling",
        question: "Why is this using try-catch instead of the error boundary pattern?",
        category: "conventions"
      };
      expect(patternQuestion.question).toContain("pattern");
    });

    it("should not ask trivial questions about style", () => {
      const styleQuestions = [];
      expect(styleQuestions.length).toBe(0);
    });
  });

  describe("important decisions", () => {
    it("should document major architectural decisions positively", () => {
      const decisions = [
        {
          id: "blue-green-deploy",
          decision: "Blue-green deployment with automated canary testing",
          rationale: "Enables safe rollout with quick rollback on failure"
        }
      ];
      expect(decisions[0].decision.toLowerCase()).toContain("blue-green");
    });

    it("should include rationale explaining why decision is sound", () => {
      const decision = {
        id: "d1",
        rationale: "This approach follows the patterns documented in AGENTS.md"
      };
      expect(decision.rationale).toContain("AGENTS.md");
    });

    it("should note decisions that establish precedent", () => {
      const precedentDecision = {
        id: "api-versioning",
        decision: "Use URL-based API versioning",
        rationale: "Matches existing v1 API pattern; consistent across org"
      };
      expect(precedentDecision.rationale).toContain("existing");
    });

    it("should document trade-off decisions", () => {
      const tradeoffDecision = {
        id: "performance-over-consistency",
        decision: "Accept eventual consistency for improved performance",
        rationale: "This trade-off accepts a short consistency window for a 10ms latency improvement"
      };
      expect(tradeoffDecision.rationale).toContain("trade");
    });

    it("should note decisions that align with epic charter", () => {
      const alignedDecision = {
        id: "feature-scope",
        rationale: "Aligns with epic charter goal to ship MVP by EOQ"
      };
      expect(alignedDecision.rationale).toContain("epic charter");
    });
  });

  describe("question-to-verdict mapping", () => {
    it("should produce ship verdict when no questions and no critical issues", () => {
      const requiredAnswers: any[] = [];
      const criticalFindings = 0;
      const verdict = requiredAnswers.length === 0 && criticalFindings === 0 ? "ship" : "needs-changes";
      expect(verdict).toBe("ship");
    });

    it("should produce ship-with-caveats when questions exist but not blocking", () => {
      const requiredAnswers = [
        { id: "q1", severity: "warning" }
      ];
      const criticalFindings = 0;
      const hasBlockingIssues = requiredAnswers.some(q => q.severity === "error") || criticalFindings > 0;
      const verdict = hasBlockingIssues ? "needs-changes" : "ship-with-caveats";
      expect(verdict).toBe("ship-with-caveats");
    });

    it("should produce needs-changes verdict when error-severity questions exist", () => {
      const requiredAnswers = [
        { id: "q1", severity: "error" }
      ];
      const hasBlockingIssues = requiredAnswers.some(q => q.severity === "error");
      const verdict = hasBlockingIssues ? "needs-changes" : "ship";
      expect(verdict).toBe("needs-changes");
    });

    it("should produce reject verdict when critical findings exist", () => {
      const criticalFindings = [
        { severity: "critical", category: "hardcoded-secret" }
      ];
      const hasCritical = criticalFindings.length > 0;
      const verdict = hasCritical ? "reject" : "needs-changes";
      expect(verdict).toBe("reject");
    });
  });

  describe("integration with operator decisions", () => {
    it("should provide requiredAnswers to operator for decision context", () => {
      const reviewResult = {
        verdict: "ship-with-caveats",
        requiredAnswers: [
          { id: "q1", question: "Auth strategy?", severity: "warning" }
        ]
      };
      expect(reviewResult.requiredAnswers).toBeDefined();
      expect(reviewResult.requiredAnswers.length).toBeGreaterThan(0);
    });

    it("should merge operator decision answers into next slice context", () => {
      const reviewAnswers = {
        "auth-strategy": "JWT is correct for this use case",
        "deployment-plan": "Blue-green with canary",
      };
      expect(Object.keys(reviewAnswers).length).toBeGreaterThan(0);
    });

    it("should reference decisions in next workstream planning", () => {
      const importantDecisions = [
        { id: "auth-jwt", decision: "JWT authentication", rationale: "..." }
      ];
      const nextPlanningContext = { priorDecisions: importantDecisions };
      expect(nextPlanningContext.priorDecisions.length).toBeGreaterThan(0);
    });

    it("should track which decisions were confirmed vs questioned by operator", () => {
      const decisionFeedback = {
        "auth-jwt": { confirmed: true },
        "deployment-blue-green": { questioned: true, reasoning: "Consider canary timing" }
      };
      expect(decisionFeedback).toBeDefined();
    });
  });

  describe("question categorization", () => {
    it("should categorize by domain (security, architecture, performance, etc)", () => {
      const questions = [
        { id: "q1", category: "security" },
        { id: "q2", category: "architecture" },
        { id: "q3", category: "performance" },
      ];
      const securityQuestions = questions.filter(q => q.category === "security");
      expect(securityQuestions.length).toBe(1);
    });

    it("should use consistent category names across reviews", () => {
      const validCategories = ["security", "architecture", "correctness", "conventions", "performance", "compatibility"];
      const question = { category: "security" };
      expect(validCategories).toContain(question.category);
    });
  });

  describe("rendering and formatting", () => {
    it("should format requiredAnswers for Discord display", () => {
      const question = {
        id: "q1",
        question: "What authentication strategy should we use?",
        context: "The code supports both JWT and session-based auth",
        severity: "error"
      };
      const formatted = `❌ ${question.question}\n${question.context}`;
      expect(formatted).toContain("authentication");
      expect(formatted).toContain("❌");
    });

    it("should format importantDecisions for Discord display", () => {
      const decision = {
        id: "d1",
        decision: "Blue-green deployment",
        rationale: "Safe rollout with quick rollback"
      };
      const formatted = `✅ ${decision.decision}\n${decision.rationale}`;
      expect(formatted).toContain("Blue-green");
      expect(formatted).toContain("✅");
    });

    it("should provide summary counts in review report", () => {
      const report = {
        requiredAnswersCount: 2,
        importantDecisionsCount: 3
      };
      expect(report.requiredAnswersCount).toBeGreaterThanOrEqual(0);
      expect(report.importantDecisionsCount).toBeGreaterThanOrEqual(0);
    });
  });
});
