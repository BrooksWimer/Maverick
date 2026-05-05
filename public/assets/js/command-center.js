(function () {
  const endpointPath = "/api/dashboard/command-center";
  const projectPath = "/api/dashboard/projects/";
  const shell = document.querySelector(".command-shell");
  const gate = document.getElementById("gate-form");
  const gateError = document.getElementById("gate-error");
  const apiBaseInput = document.getElementById("api-base");
  const tokenInput = document.getElementById("api-token");
  const syncStatus = document.getElementById("sync-status");
  const refreshButton = document.getElementById("refresh-button");
  const lockButton = document.getElementById("lock-button");
  const actionModal = document.getElementById("action-modal");
  const actionForm = document.getElementById("action-form");

  function readMetaContent(name) {
    const el = document.querySelector('meta[name="' + name + '"]');
    const raw = el && el.getAttribute("content");
    return raw ? String(raw).trim() : "";
  }

  function defaultApiBaseForPage() {
    const fromMeta = readMetaContent("maverick-dashboard-api-base");
    if (fromMeta) {
      return normalizeBase(fromMeta);
    }
    const host = (location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "") {
      return "http://127.0.0.1:3847";
    }
    return "https://maverick.brookswimer.com";
  }

  const sectionLabels = {
    focus: "Focus",
    next: "Next",
    later: "Later",
    waiting: "Waiting",
  };

  const state = {
    apiBase: localStorage.getItem("maverickCommandCenter.apiBase") || defaultApiBaseForPage(),
    token: sessionStorage.getItem("maverickCommandCenter.token") || "",
    lastPayload: null,
    detailCache: new Map(),
    detailLoading: new Set(),
  };

  apiBaseInput.value = state.apiBase;
  tokenInput.value = state.token;

  gate.addEventListener("submit", function (event) {
    event.preventDefault();
    state.apiBase = normalizeBase(apiBaseInput.value);
    state.token = tokenInput.value.trim();
    localStorage.setItem("maverickCommandCenter.apiBase", state.apiBase);
    if (state.token) {
      sessionStorage.setItem("maverickCommandCenter.token", state.token);
    } else {
      sessionStorage.removeItem("maverickCommandCenter.token");
    }
    state.detailCache.clear();
    loadDashboard();
  });

  refreshButton.addEventListener("click", function () {
    state.detailCache.clear();
    loadDashboard();
  });

  lockButton.addEventListener("click", function () {
    state.token = "";
    sessionStorage.removeItem("maverickCommandCenter.token");
    tokenInput.value = "";
    setView("auth");
    setSync("Locked", "warn");
  });

  document.addEventListener("click", function (event) {
    const control = event.target.closest("[data-action]");
    if (!control) {
      return;
    }
    const action = control.dataset.action;
    if (!action) {
      return;
    }
    event.preventDefault();
    handleAction(action, control);
  });

  document.getElementById("modal-project-input").addEventListener("change", function () {
    populateLaneSelect(this.value, null);
  });

  actionForm.addEventListener("submit", function (event) {
    event.preventDefault();
    submitModal();
  });

  window.addEventListener("hashchange", function () {
    if (state.lastPayload) {
      render(state.lastPayload);
    }
  });

  if (!location.hash) {
    location.hash = "#/today";
  }
  loadDashboard();

  async function loadDashboard() {
    setView(state.lastPayload ? "ready" : "loading");
    setSync("Refreshing", "warn");
    gateError.textContent = "";

    try {
      const payload = await dashboardFetch(endpointPath);
      state.lastPayload = payload;
      render(payload);
      setView("ready");
      setSync("Live", toneForHealth(payload.health && payload.health.status));
    } catch (error) {
      if (error && error.status === 401) {
        setView("auth");
        setSync("Auth required", "warn");
        gateError.textContent = "Access token required.";
        return;
      }
      if (!state.lastPayload) {
        setView("auth");
      }
      setSync("API unavailable", "danger");
      gateError.textContent = error instanceof Error ? error.message : "Unable to connect.";
      renderUnavailable(error);
    }
  }

  async function loadProjectDetail(projectId) {
    if (state.detailCache.has(projectId) || state.detailLoading.has(projectId)) {
      return;
    }
    state.detailLoading.add(projectId);
    renderProjectDetailLoading(projectId);

    try {
      const detail = await dashboardFetch(projectPath + encodeURIComponent(projectId));
      state.detailCache.set(projectId, detail);
      if (routeFromHash().projectId === projectId && state.lastPayload) {
        render(state.lastPayload);
      }
    } catch (error) {
      if (error && error.status === 401) {
        setView("auth");
        setSync("Auth required", "warn");
        return;
      }
      state.detailCache.set(projectId, {
        projectId: projectId,
        projectName: projectId,
        status: "attention",
        headline: error instanceof Error ? error.message : "Unable to load project.",
        lanes: [],
        notes: [],
        tasks: [],
        calendarEvents: [],
        workstreams: [],
        unresolvedCaptures: [],
        evidenceLinks: [],
        keyUpdates: [],
        actionItems: [],
      });
      if (state.lastPayload) {
        render(state.lastPayload);
      }
    } finally {
      state.detailLoading.delete(projectId);
    }
  }

  async function dashboardFetch(path, options) {
    if (!path.startsWith("/api/dashboard/")) {
      throw new Error("Blocked non-dashboard endpoint.");
    }
    const response = await fetch(state.apiBase + path, {
      method: options && options.method ? options.method : "GET",
      credentials: "include",
      headers: Object.assign(
        {},
        authHeaders(),
        options && options.payload !== undefined ? { "content-type": "application/json" } : {}
      ),
      body: options && options.payload !== undefined ? JSON.stringify(options.payload) : undefined,
    });
    if (response.status === 401) {
      const error = new Error("Unauthorized");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      let message = "HTTP " + response.status;
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {
        /* keep HTTP status */
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function mutate(path, method, payload, successLabel) {
    setSync("Saving", "warn");
    try {
      const result = await dashboardFetch(path, { method: method, payload: payload });
      state.detailCache.clear();
      await loadDashboard();
      setSync(successLabel || "Saved", "ok");
      return result;
    } catch (error) {
      if (error && error.status === 401) {
        setView("auth");
        setSync("Auth required", "warn");
      } else {
        setSync("Save failed", "danger");
      }
      setModalError(error instanceof Error ? error.message : "Unable to save.");
      throw error;
    }
  }

  function render(payload) {
    const route = routeFromHash();
    renderMainNav(payload.projectTabs || payload.projectIntelligenceSummaries || []);
    setActiveRoute(route);
    setText("generated-at", "Generated " + formatTime(payload.generatedAt));
    setText("next-action", payload.nextAction || "No action available.");
    setText("metric-health", labelHealth(payload.health && payload.health.status));
    setText("metric-workstreams", String(payload.activeWorkstreams.length));
    setText("metric-approvals", String(payload.pendingApprovals.length));
    setText("metric-tasks", String(payload.taskSummary.totalActionable));
    setText("task-total", payload.todayPlan ? payload.todayPlan.headline : payload.taskSummary.totalActionable + " total");
    setText("approval-count", payload.pendingApprovals.length + " waiting");
    setText("project-count", (payload.projectTabs || payload.projectIntelligenceSummaries || []).length + " projects");
    setText("workstream-count", payload.activeWorkstreams.length + " active");
    setText("report-count", payload.latestReports.length + " recent");
    setText("note-count", payload.recentNotes.length + " recent");

    renderProjectTabs(payload.projectTabs || payload.projectIntelligenceSummaries || []);
    renderTaskMetrics(payload.taskSummary);
    renderApprovals(payload.pendingApprovals);
    renderWorkstreams(payload.activeWorkstreams);
    renderReports(payload.latestReports);
    renderNotes(payload.recentNotes);

    if (route.view === "projects") {
      renderProjects(payload.projectTabs || payload.projectIntelligenceSummaries || [], payload.projectIntelligenceSummaries || []);
    } else if (route.view === "project-detail" && route.projectId) {
      renderProjectDetailRoute(payload, route.projectId);
    } else {
      renderToday(payload.todayPlan, payload.assistantAgenda);
    }
  }

  function renderToday(todayPlan, agenda) {
    showRoute("today");
    if (!todayPlan) {
      renderTaskQueue(agenda);
      empty("today-plan-board", "No live plan board.");
      return;
    }
    setText("today-task-count", todayPlan.tasks.length + " queued");
    setText("today-personal-count", todayPlan.personal.length + " queued");
    setText("planning-note-count", todayPlan.planningNotes.length + " recent");
    renderPlanBoard(todayPlan.planBoard);
    renderPlanItems("today-focus", todayPlan.focus, "No focus items.");
    renderCalendar("today-calendar", todayPlan.calendarEvents, "No calendar events today.");
    renderPlanItems("today-tasks", todayPlan.tasks, "No queued tasks.");
    renderPlanItems("today-personal", todayPlan.personal, "No personal tasks.");
    renderNotesInto("planning-notes", todayPlan.planningNotes, "No planning notes.");
  }

  function renderPlanBoard(planBoard) {
    if (!planBoard || !planBoard.sections) {
      empty("today-plan-board", "No plan board yet.");
      return;
    }
    const html = Object.keys(sectionLabels).map(function (section) {
      const items = planBoard.sections[section] || [];
      const cards = items.length
        ? items.map(renderPlanBoardItem).join("")
        : '<div class="empty">Nothing queued.</div>';
      return [
        '<section class="plan-column">',
        '<div class="panel-subhead"><h4>' + escapeHtml(sectionLabels[section]) + '</h4>',
        '<button class="mini-action" type="button" data-action="plan-new" data-section="' + escapeHtml(section) + '" title="Add item"><i class="fas fa-plus" aria-hidden="true"></i></button></div>',
        cards,
        '</section>',
      ].join("");
    }).join("");
    fill("today-plan-board", html);
  }

  function renderPlanBoardItem(item) {
    return queueItem(item.title, item.details || "", [
      item.projectId ? tag(item.projectId, "ok") : "",
      item.laneId ? tag(item.laneId, "ok") : "",
      tag(item.status || "active", toneForTask(item.status)),
      renderEvidenceInline(item.evidenceLinks),
    ].join(""), [
      actionButton("fas fa-edit", "Edit", "plan-edit", "plan", item.id),
      actionButton("fas fa-trash", "Delete", "plan-delete", "plan", item.id),
    ].join(""));
  }

  function renderProjects(tabs, summaries) {
    showRoute("projects");
    const summaryByProject = new Map((summaries || []).map(function (summary) {
      return [summary.projectId, summary];
    }));
    if (!tabs || tabs.length === 0) {
      empty("project-grid", "No project intelligence yet.");
      return;
    }
    fill("project-grid", tabs.map(function (tab) {
      const project = summaryByProject.get(tab.projectId) || tab;
      const updates = (project.keyUpdates || []).slice(0, 3).map(function (update) {
        return "<li>" + escapeHtml(update) + "</li>";
      }).join("");
      const actions = (project.actionItems || []).slice(0, 3).map(function (action) {
        return "<li>" + escapeHtml(action) + "</li>";
      }).join("");
      return [
        '<a class="project-card" href="#/projects/' + encodeURIComponent(tab.projectId) + '">',
        '<div class="queue-title"><strong>' + escapeHtml(tab.projectName) + '</strong>' + healthBadge(tab.status) + '</div>',
        '<p>' + escapeHtml(tab.headline || "No recent activity.") + '</p>',
        '<div class="project-meta">',
        tag((tab.laneCount || 0) + " lanes", "ok"),
        tag((tab.activeWorkstreamCount || 0) + " active", tab.activeWorkstreamCount > 0 ? "warn" : "ok"),
        tag((tab.actionItemCount || 0) + " actions", tab.actionItemCount > 0 ? "warn" : "ok"),
        '</div>',
        updates ? '<h3>Updates</h3><ul>' + updates + '</ul>' : '',
        actions ? '<h3>Actions</h3><ul>' + actions + '</ul>' : '',
        '</a>',
      ].join("");
    }).join(""));
  }

  function renderProjectDetailRoute(payload, projectId) {
    showRoute("project-detail");
    if (!state.detailCache.has(projectId)) {
      loadProjectDetail(projectId);
      renderProjectDetailLoading(projectId);
      return;
    }
    renderProjectDetail(state.detailCache.get(projectId), payload.projectIntelligenceSummaries);
  }

  function renderProjectDetailLoading(projectId) {
    setText("detail-project-id", projectId);
    setText("detail-project-name", "Loading");
    setText("detail-project-headline", "Fetching project report.");
    ["detail-lanes", "detail-tasks", "detail-notes", "detail-evidence", "detail-calendar", "detail-unresolved"].forEach(function (id) {
      empty(id, "Loading.");
    });
  }

  function renderProjectDetail(detail, summaries) {
    const summary = (summaries || []).find(function (item) {
      return item.projectId === detail.projectId;
    });
    setText("detail-project-id", detail.projectId || "project");
    setText("detail-project-name", detail.projectName || detail.projectId || "Project");
    setText("detail-project-headline", detail.headline || "No project report available.");
    setText("detail-lane-count", (detail.lanes || []).length + " lanes");
    setText("detail-task-count", (detail.tasks || []).length + " tasks");
    setText("detail-note-count", (detail.notes || []).length + " notes");
    setText("detail-evidence-count", (detail.evidenceLinks || []).length + " links");
    setText("detail-calendar-count", (detail.calendarEvents || []).length + " events");
    setText("detail-unresolved-count", (detail.unresolvedCaptures || []).length + " captures");

    fill("detail-meta", [
      healthBadge(detail.status),
      tag((detail.laneCount || 0) + " lanes", "ok"),
      tag((detail.activeWorkstreamCount || 0) + " active", detail.activeWorkstreamCount > 0 ? "warn" : "ok"),
      summary && summary.latestNoteAt ? tag("latest " + formatTime(summary.latestNoteAt), "ok") : "",
    ].join(""));

    renderLaneSections(detail);
    renderProjectTasks(detail.tasks || []);
    renderNotesInto("detail-notes", detail.notes || [], "No notes for this project.");
    renderEvidence("detail-evidence", detail.evidenceLinks || []);
    renderCalendar("detail-calendar", detail.calendarEvents || [], "No project calendar events.");
    renderUnresolved(detail.unresolvedCaptures || []);
  }

  function renderLaneSections(detail) {
    const lanes = detail.lanes || [];
    if (lanes.length === 0) {
      empty("detail-lanes", "No lane activity.");
      return;
    }
    fill("detail-lanes", lanes.map(function (lane) {
      const laneId = lane.laneId || "general";
      const tasks = (detail.tasks || []).filter(function (item) { return laneKey(item) === laneId; });
      const notes = (detail.notes || []).filter(function (item) { return laneKey(item) === laneId; });
      const captures = (detail.unresolvedCaptures || []).filter(function (item) { return laneKey(item) === laneId; });
      const calendar = (detail.calendarEvents || []).filter(function (item) { return laneKey(item) === laneId; });
      const workstreams = (detail.workstreams || []).filter(function (item) {
        return (item.epicId || item.workstreamId) === laneId;
      });
      return [
        '<section class="lane-section">',
        '<div class="queue-title"><strong>' + escapeHtml(lane.label || titleFromId(laneId)) + '</strong><span>' + [
          tag(lane.noteCount + " notes", "ok"),
          tag(lane.taskCount + " tasks", lane.taskCount > 0 ? "warn" : "ok"),
          lane.unresolvedCaptureCount ? tag(lane.unresolvedCaptureCount + " unresolved", "danger") : "",
        ].join("") + '</span></div>',
        '<p>' + escapeHtml(lane.headline || "No recent lane action.") + '</p>',
        '<div class="lane-grid">',
        laneGroup("Tasks", tasks, renderTaskCard, "No tasks."),
        laneGroup("Notes", notes, renderNoteCard, "No notes."),
        laneGroup("Captures", captures, renderCaptureCard, "No captures."),
        laneGroup("Calendar", calendar, renderCalendarCard, "No events."),
        laneGroup("Workstreams", workstreams, renderWorkstreamCard, "No workstreams."),
        '</div>',
        '</section>',
      ].join("");
    }).join(""));
  }

  function laneGroup(title, items, renderer, emptyMessage) {
    return [
      '<div class="lane-group"><h4>' + escapeHtml(title) + '</h4>',
      items.length ? items.map(renderer).join("") : '<div class="empty">' + escapeHtml(emptyMessage) + '</div>',
      '</div>',
    ].join("");
  }

  function renderProjectTasks(tasks) {
    if (tasks.length === 0) {
      empty("detail-tasks", "No action items.");
      return;
    }
    fill("detail-tasks", tasks.map(renderTaskCard).join(""));
  }

  function renderTaskCard(task) {
    return queueItem(task.title, task.details || task.primaryContext, [
      tag(task.status, toneForTask(task.status)),
      itemProject(task) ? tag(itemProject(task), "ok") : "",
      laneKey(task) !== "general" ? tag(laneKey(task), "ok") : "",
      task.dueAt ? tag(formatTime(task.dueAt), "warn") : "",
      renderEvidenceInline(task.evidenceLinks),
    ].join(""), [
      task.status !== "done" ? actionButton("fas fa-check", "Done", "task-done", "task", task.id) : "",
      actionButton("fas fa-edit", "Edit", "task-edit", "task", task.id),
      actionButton("fas fa-calendar-alt", "Schedule", "task-schedule", "task", task.id),
      actionButton("fas fa-folder-open", "Move", "item-assign", "task", task.id),
      actionButton("fas fa-plus", "Add to plan", "item-plan", "task", task.id),
    ].join(""), task.status === "done" ? "done" : null);
  }

  function renderNoteCard(note) {
    return queueItem(note.title, note.excerpt, [
      tag(note.context, "ok"),
      itemProject(note) ? tag(itemProject(note), "warn") : "",
      laneKey(note) !== "general" ? tag(laneKey(note), "ok") : "",
      renderEvidenceInline(note.evidenceLinks),
    ].join(""), [
      actionButton("fas fa-folder-open", "Move", "item-assign", "note", note.id),
      actionButton("fas fa-plus", "Add to plan", "item-plan", "note", note.id),
      actionButton("fas fa-list-check", "Convert to task", "note-task", "note", note.id),
    ].join(""));
  }

  function renderCaptureCard(item) {
    return queueItem(item.excerpt || item.body, item.status || "unresolved", [
      itemProject(item) ? tag(itemProject(item), "warn") : "",
      laneKey(item) !== "general" ? tag(laneKey(item), "ok") : "",
      renderEvidenceInline(item.evidenceLinks),
    ].join(""), [
      actionButton("fas fa-folder-open", "Move", "item-assign", "capture", item.id),
      actionButton("fas fa-plus", "Add to plan", "item-plan", "capture", item.id),
      actionButton("fas fa-list-check", "Convert to task", "capture-task", "capture", item.id),
    ].join(""));
  }

  function renderCalendarCard(event) {
    return queueItem(event.title, [
      formatTime(event.startsAt),
      event.details || "",
      event.location || "",
    ].filter(Boolean).join(" - "), [
      tag(event.syncStatus, event.syncStatus === "synced" ? "ok" : "warn"),
      itemProject(event) ? tag(itemProject(event), "ok") : "",
      laneKey(event) !== "general" ? tag(laneKey(event), "ok") : "",
      renderEvidenceInline(event.evidenceLinks),
    ].join(""), [
      actionButton("fas fa-folder-open", "Move", "item-assign", "calendar", event.id),
      actionButton("fas fa-plus", "Add to plan", "item-plan", "calendar", event.id),
    ].join(""));
  }

  function renderWorkstreamCard(workstream) {
    return queueItem(workstream.workstreamName, workstream.nextAction || workstream.currentGoal || workstream.state, [
      tag(workstream.projectId, "ok"),
      healthBadge(workstream.health),
    ].join(""));
  }

  function renderPlanItems(id, items, emptyMessage) {
    if (!items || items.length === 0) {
      empty(id, emptyMessage);
      return;
    }
    fill(id, items.map(function (item) {
      const type = item.source === "task" ? "task" : item.source;
      return queueItem(item.title, item.details, [
        item.projectId ? tag(item.projectId, "ok") : "",
        item.laneId ? tag(item.laneId, "ok") : "",
        item.status ? tag(item.status, toneForTask(item.status)) : "",
        renderEvidenceInline(item.evidenceLinks),
      ].join(""), [
        type === "task" && item.status !== "done" ? actionButton("fas fa-check", "Done", "task-done", "task", item.id) : "",
        type === "task" ? actionButton("fas fa-edit", "Edit", "task-edit", "task", item.id) : "",
        type === "task" ? actionButton("fas fa-calendar-alt", "Schedule", "task-schedule", "task", item.id) : "",
        ["task", "note", "capture", "calendar"].includes(type) ? actionButton("fas fa-plus", "Add to plan", "item-plan", type, item.id) : "",
      ].join(""));
    }).join(""));
  }

  function renderCalendar(id, events, emptyMessage) {
    if (!events || events.length === 0) {
      empty(id, emptyMessage);
      return;
    }
    fill(id, events.map(renderCalendarCard).join(""));
  }

  function renderUnresolved(items) {
    if (items.length === 0) {
      empty("detail-unresolved", "No unresolved captures.");
      return;
    }
    fill("detail-unresolved", items.map(renderCaptureCard).join(""));
  }

  function renderTaskMetrics(summary) {
    const items = [
      ["Overdue", summary.overdue, summary.overdue > 0 ? "danger" : "ok"],
      ["Today", summary.dueToday, summary.dueToday > 0 ? "warn" : "ok"],
      ["Open", summary.open, summary.open > 0 ? "warn" : "ok"],
      ["Scheduled", summary.scheduled, "ok"],
      ["Inbox", summary.inbox, summary.inbox > 0 ? "warn" : "ok"],
    ];
    fill("task-metrics", items.map(function (item) {
      return '<div class="task-chip" data-tone="' + item[2] + '"><strong>' + escapeHtml(item[1]) + '</strong><span>' + escapeHtml(item[0]) + '</span></div>';
    }).join(""));
  }

  function renderTaskQueue(agenda) {
    if (!agenda) {
      empty("today-tasks", "Assistant data unavailable.");
      return;
    }
    const tasks = uniqueById([].concat(
      agenda.overdueTasks || [],
      agenda.dueTodayTasks || [],
      agenda.inboxTasks || [],
      agenda.openTasks || [],
      agenda.scheduledTasks || []
    )).slice(0, 8);
    if (tasks.length === 0) {
      empty("today-tasks", "No active tasks.");
      return;
    }
    fill("today-tasks", tasks.map(renderTaskCard).join(""));
  }

  function renderApprovals(approvals) {
    if (approvals.length === 0) {
      empty("approval-list", "No pending approvals.");
      return;
    }
    fill("approval-list", approvals.map(function (approval) {
      return queueItem(approval.description, approval.workstreamName || approval.workstreamId, [
        tag(approval.projectId || "project", "ok"),
        tag(approval.tier, "warn"),
      ].join(""));
    }).join(""));
  }

  function renderWorkstreams(workstreams) {
    if (workstreams.length === 0) {
      empty("workstream-list", "No active workstreams.");
      return;
    }
    fill("workstream-list", workstreams.map(renderWorkstreamCard).join(""));
  }

  function renderReports(reports) {
    if (reports.length === 0) {
      empty("report-list", "No recent reports.");
      return;
    }
    fill("report-list", reports.slice(0, 8).map(function (report) {
      return queueItem(report.headline, report.summary || report.nextAction, [
        tag(report.kind, "ok"),
        tag(report.projectId, "warn"),
      ].join(""));
    }).join(""));
  }

  function renderNotes(notes) {
    renderNotesInto("note-list", notes, "No recent notes.");
  }

  function renderNotesInto(id, notes, emptyMessage) {
    if (!notes || notes.length === 0) {
      empty(id, emptyMessage);
      return;
    }
    fill(id, notes.map(renderNoteCard).join(""));
  }

  function renderMainNav(projects) {
    fill("project-nav-tabs", projects.map(function (project) {
      return '<a href="#/projects/' + encodeURIComponent(project.projectId) + '" data-route-link="project:' + escapeHtml(project.projectId) + '">' + escapeHtml(project.projectName) + '</a>';
    }).join(""));
  }

  function renderProjectTabs(projects) {
    if (!projects || projects.length === 0) {
      fill("project-tabs", "");
      return;
    }
    fill("project-tabs", projects.map(function (project) {
      return '<a href="#/projects/' + encodeURIComponent(project.projectId) + '">' + escapeHtml(project.projectName) + '</a>';
    }).join(""));
  }

  function renderEvidence(id, links) {
    if (!links || links.length === 0) {
      empty(id, "No evidence links.");
      return;
    }
    fill(id, links.map(function (link) {
      return evidenceLink(link, "queue-item evidence-item");
    }).join(""));
  }

  function renderEvidenceInline(links) {
    if (!links || links.length === 0) {
      return "";
    }
    return '<span class="evidence-inline">' + links.slice(0, 3).map(function (link) {
      return evidenceLink(link, "tag evidence-tag");
    }).join("") + '</span>';
  }

  function evidenceLink(link, className) {
    const label = escapeHtml(link.label || link.kind || "link");
    const target = String(link.target || "");
    const safeTarget = escapeHtml(target);
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
      return '<a class="' + className + '" href="' + safeTarget + '" target="_blank" rel="noreferrer">' + label + '</a>';
    }
    if (target.startsWith("/api/")) {
      return '<a class="' + className + '" href="' + escapeHtml(state.apiBase + target) + '" target="_blank" rel="noreferrer">' + label + '</a>';
    }
    return '<span class="' + className + '" title="' + safeTarget + '">' + label + '</span>';
  }

  async function handleAction(action, control) {
    try {
      if (action === "modal-close") {
        closeModal();
        return;
      }
      if (action === "task-done") {
        await mutate("/api/dashboard/tasks/" + encodeURIComponent(control.dataset.itemId) + "/complete", "POST", {}, "Task done");
        return;
      }
      if (action === "task-edit") {
        openTaskEdit(control.dataset.itemId);
        return;
      }
      if (action === "task-schedule") {
        openTaskSchedule(control.dataset.itemId);
        return;
      }
      if (action === "item-assign") {
        openAssignment(control.dataset.itemType, control.dataset.itemId);
        return;
      }
      if (action === "item-plan" || action === "plan-new") {
        openPlanNew(control.dataset.itemType || null, control.dataset.itemId || null, control.dataset.section || null);
        return;
      }
      if (action === "note-task") {
        await mutate("/api/dashboard/notes/" + encodeURIComponent(control.dataset.itemId) + "/task", "POST", {}, "Task created");
        return;
      }
      if (action === "capture-task") {
        await mutate("/api/dashboard/captures/" + encodeURIComponent(control.dataset.itemId) + "/task", "POST", {}, "Task created");
        return;
      }
      if (action === "plan-edit") {
        openPlanEdit(control.dataset.itemId);
        return;
      }
      if (action === "plan-delete") {
        await mutate("/api/dashboard/plans/today/items/" + encodeURIComponent(control.dataset.itemId), "DELETE", undefined, "Plan item deleted");
      }
    } catch {
      /* mutate/open helpers already surface errors */
    }
  }

  function openTaskEdit(taskId) {
    const task = findItem("task", taskId);
    openModal("task-edit", "Edit task", "task", taskId, ["title", "details", "status"], {
      title: task && task.title,
      details: task && task.details,
      status: task && task.status,
    });
  }

  function openTaskSchedule(taskId) {
    const task = findItem("task", taskId);
    openModal("task-schedule", "Schedule task", "task", taskId, ["scheduled"], {
      scheduled: toLocalInput(task && (task.scheduledFor || task.dueAt)),
    });
  }

  function openAssignment(itemType, itemId) {
    const item = findItem(itemType, itemId);
    openModal("item-assign", "Move item", itemType, itemId, ["project", "lane"], {
      projectId: itemProject(item),
      laneId: laneKey(item),
    });
  }

  function openPlanNew(itemType, itemId, section) {
    const item = itemType && itemId ? findItem(itemType, itemId) : null;
    openModal("plan-new", item ? "Add to plan" : "New plan item", itemType || "", itemId || "", ["title", "details", "section", "project", "lane"], {
      title: item && item.title,
      details: item && (item.details || item.excerpt || item.body),
      section: section || "focus",
      projectId: itemProject(item),
      laneId: laneKey(item),
    });
  }

  function openPlanEdit(itemId) {
    const item = findPlanItem(itemId);
    openModal("plan-edit", "Edit plan item", "plan", itemId, ["title", "details", "section", "project", "lane"], {
      title: item && item.title,
      details: item && item.details,
      section: item && item.section,
      projectId: item && item.projectId,
      laneId: item && (item.laneId || "general"),
    });
  }

  function openModal(mode, title, itemType, itemId, fields, values) {
    document.getElementById("modal-mode").value = mode;
    document.getElementById("modal-item-type").value = itemType || "";
    document.getElementById("modal-item-id").value = itemId || "";
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-title-input").value = values.title || "";
    document.getElementById("modal-details-input").value = values.details || "";
    document.getElementById("modal-status-input").value = values.status || "open";
    document.getElementById("modal-scheduled-input").value = values.scheduled || "";
    document.getElementById("modal-section-input").value = values.section || "focus";
    document.querySelectorAll(".modal-field").forEach(function (field) {
      field.hidden = !fields.includes(field.dataset.field);
    });
    populateProjectSelect(values.projectId || null);
    populateLaneSelect(document.getElementById("modal-project-input").value, values.laneId || null);
    setModalError("");
    actionModal.hidden = false;
  }

  function closeModal() {
    actionModal.hidden = true;
    setModalError("");
  }

  async function submitModal() {
    const mode = document.getElementById("modal-mode").value;
    const itemType = document.getElementById("modal-item-type").value;
    const itemId = document.getElementById("modal-item-id").value;
    const projectId = document.getElementById("modal-project-input").value || null;
    const laneId = document.getElementById("modal-lane-input").value || null;
    const title = document.getElementById("modal-title-input").value.trim();
    const details = document.getElementById("modal-details-input").value.trim();
    const status = document.getElementById("modal-status-input").value;
    const section = document.getElementById("modal-section-input").value;
    const scheduled = document.getElementById("modal-scheduled-input").value;

    if (mode === "task-edit") {
      await mutate("/api/dashboard/tasks/" + encodeURIComponent(itemId), "PATCH", {
        title: title,
        details: details,
        status: status,
      }, "Task saved");
    } else if (mode === "task-schedule") {
      await mutate("/api/dashboard/tasks/" + encodeURIComponent(itemId), "PATCH", {
        status: "scheduled",
        dueAt: toIsoFromLocal(scheduled),
        scheduledFor: toIsoFromLocal(scheduled),
      }, "Task scheduled");
    } else if (mode === "item-assign") {
      await mutate("/api/dashboard/items/" + encodeURIComponent(itemType) + "/" + encodeURIComponent(itemId) + "/assignment", "PATCH", {
        projectId: projectId,
        laneId: laneId === "general" ? null : laneId,
      }, "Item moved");
    } else if (mode === "plan-new") {
      await mutate("/api/dashboard/plans/today/items", "POST", {
        section: section,
        title: title,
        details: details,
        itemType: itemType || null,
        itemId: itemId || null,
        projectId: projectId,
        laneId: laneId === "general" ? null : laneId,
      }, "Plan item added");
    } else if (mode === "plan-edit") {
      await mutate("/api/dashboard/plans/today/items/" + encodeURIComponent(itemId), "PATCH", {
        section: section,
        title: title,
        details: details,
        projectId: projectId,
        laneId: laneId === "general" ? null : laneId,
      }, "Plan item saved");
    }
    closeModal();
  }

  function populateProjectSelect(selectedProjectId) {
    const select = document.getElementById("modal-project-input");
    const options = state.lastPayload && state.lastPayload.organizationOptions
      ? state.lastPayload.organizationOptions
      : [];
    select.innerHTML = '<option value="">Unassigned</option>' + options.map(function (option) {
      return '<option value="' + escapeHtml(option.projectId) + '">' + escapeHtml(option.projectName) + '</option>';
    }).join("");
    select.value = selectedProjectId || "";
  }

  function populateLaneSelect(projectId, selectedLaneId) {
    const select = document.getElementById("modal-lane-input");
    const project = state.lastPayload && state.lastPayload.organizationOptions
      ? state.lastPayload.organizationOptions.find(function (option) { return option.projectId === projectId; })
      : null;
    const lanes = project ? project.lanes : [];
    select.innerHTML = '<option value="general">General</option>' + lanes
      .filter(function (lane) { return lane.laneId !== "general"; })
      .map(function (lane) {
        return '<option value="' + escapeHtml(lane.laneId) + '">' + escapeHtml(lane.label || lane.laneId) + '</option>';
      }).join("");
    select.value = selectedLaneId && selectedLaneId !== "general" ? selectedLaneId : "general";
  }

  function findItem(type, id) {
    if (!id) {
      return null;
    }
    const detailItems = Array.from(state.detailCache.values()).flatMap(function (detail) {
      return []
        .concat(detail.tasks || [])
        .concat(detail.notes || [])
        .concat(detail.calendarEvents || [])
        .concat(detail.unresolvedCaptures || []);
    });
    const payload = state.lastPayload || {};
    const today = payload.todayPlan || {};
    const items = []
      .concat(detailItems)
      .concat(payload.recentNotes || [])
      .concat(today.focus || [])
      .concat(today.tasks || [])
      .concat(today.personal || [])
      .concat(today.calendarEvents || [])
      .concat(today.planningNotes || []);
    return items.find(function (item) {
      return item && item.id === id && (!type || itemMatchesType(item, type));
    }) || items.find(function (item) { return item && item.id === id; }) || null;
  }

  function findPlanItem(id) {
    const board = state.lastPayload && state.lastPayload.todayPlan && state.lastPayload.todayPlan.planBoard;
    if (!board || !board.sections) {
      return null;
    }
    return Object.keys(board.sections)
      .flatMap(function (section) { return board.sections[section] || []; })
      .find(function (item) { return item.id === id; }) || null;
  }

  function itemMatchesType(item, type) {
    if (type === "task") return "status" in item && ("primaryContext" in item || item.source === "task");
    if (type === "note") return "excerpt" in item && "context" in item;
    if (type === "capture") return "body" in item || item.intent !== undefined;
    if (type === "calendar") return "startsAt" in item && "syncStatus" in item;
    return true;
  }

  function renderUnavailable(error) {
    if (state.lastPayload) {
      return;
    }
    setText("generated-at", "Offline");
    setText("next-action", error instanceof Error ? error.message : "Unable to connect.");
    setText("metric-health", "down");
    setText("metric-workstreams", "0");
    setText("metric-approvals", "0");
    setText("metric-tasks", "0");
    [
      "today-plan-board",
      "today-focus",
      "today-calendar",
      "today-tasks",
      "today-personal",
      "planning-notes",
      "approval-list",
      "project-grid",
      "workstream-list",
      "report-list",
      "note-list",
    ].forEach(function (id) {
      empty(id, "No live data.");
    });
  }

  function routeFromHash() {
    const value = (location.hash || "#/today").replace(/^#/, "");
    const parts = value.split("/").filter(Boolean);
    if (parts[0] === "projects" && parts[1]) {
      return { view: "project-detail", projectId: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === "projects") {
      return { view: "projects", projectId: null };
    }
    return { view: "today", projectId: null };
  }

  function setActiveRoute(route) {
    document.querySelectorAll("[data-route-link]").forEach(function (link) {
      const value = link.dataset.routeLink;
      const active = value === route.view ||
        (route.view === "project-detail" && value === "project:" + route.projectId);
      link.toggleAttribute("aria-current", active);
    });
  }

  function showRoute(view) {
    document.querySelectorAll("[data-route-view]").forEach(function (element) {
      element.hidden = element.dataset.routeView !== view;
    });
  }

  function queueItem(title, body, meta, actions, stateValue) {
    return [
      '<div class="queue-item"' + (stateValue ? ' data-state="' + escapeHtml(stateValue) + '"' : "") + '>',
      '<div class="queue-title"><strong>' + escapeHtml(title || "Untitled") + '</strong><span>' + (meta || "") + '</span></div>',
      body ? '<p>' + escapeHtml(body) + '</p>' : '',
      actions ? '<div class="item-actions">' + actions + '</div>' : '',
      '</div>',
    ].join("");
  }

  function actionButton(icon, label, action, itemType, itemId) {
    return [
      '<button class="mini-action" type="button" title="' + escapeHtml(label) + '" data-action="' + escapeHtml(action) + '"',
      itemType ? ' data-item-type="' + escapeHtml(itemType) + '"' : '',
      itemId ? ' data-item-id="' + escapeHtml(itemId) + '"' : '',
      '><i class="' + escapeHtml(icon) + '" aria-hidden="true"></i></button>',
    ].join("");
  }

  function tag(label, tone) {
    if (!label && label !== 0) {
      return "";
    }
    return '<span class="tag" data-tone="' + escapeHtml(tone || "ok") + '">' + escapeHtml(label) + '</span>';
  }

  function healthBadge(health) {
    return '<span class="health-badge" data-tone="' + toneForHealth(health) + '">' + escapeHtml(health || "ok") + '</span>';
  }

  function toneForHealth(health) {
    if (health === "failed" || health === "blocked" || health === "unavailable" || health === "attention") {
      return "danger";
    }
    if (health === "waiting-on-approval" || health === "awaiting-input" || health === "quiet" || health === "active") {
      return "warn";
    }
    return "ok";
  }

  function toneForTask(status) {
    if (status === "overdue" || status === "failed") {
      return "danger";
    }
    if (status === "inbox" || status === "open" || status === "scheduled" || status === "active") {
      return "warn";
    }
    return "ok";
  }

  function itemProject(item) {
    return item ? item.effectiveProjectId || item.projectId || item.sourceProjectId || null : null;
  }

  function laneKey(item) {
    return item ? item.effectiveLaneId || item.laneId || "general" : "general";
  }

  function labelHealth(status) {
    return status || "unknown";
  }

  function setView(view) {
    shell.dataset.view = view;
  }

  function setSync(label, tone) {
    syncStatus.textContent = label;
    syncStatus.dataset.tone = tone || "ok";
  }

  function setModalError(value) {
    const element = document.getElementById("modal-error");
    if (element) {
      element.textContent = value || "";
    }
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  }

  function fill(id, html) {
    const element = document.getElementById(id);
    if (element) {
      element.innerHTML = html;
    }
  }

  function empty(id, message) {
    fill(id, '<div class="empty">' + escapeHtml(message) + '</div>');
  }

  function uniqueById(items) {
    const seen = new Set();
    return items.filter(function (item) {
      if (!item || seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }

  function authHeaders() {
    return state.token ? { authorization: "Bearer " + state.token } : {};
  }

  function normalizeBase(value) {
    return value.trim().replace(/\/+$/, "");
  }

  function formatTime(value) {
    if (!value) {
      return "--";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function toLocalInput(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function toIsoFromLocal(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function titleFromId(value) {
    return String(value || "general")
      .split(/[-_]/g)
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}());
