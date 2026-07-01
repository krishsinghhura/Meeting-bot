const API_BASE = "http://localhost:3001";

type User = {
  id: string;
  email: string;
};

type MeetingJob = {
  id: string;
  meetingUrl: string;
  status: string;
  meetingId: string | null;
  createdAt: string;
  updatedAt: string;
};

type MeetingResults = {
  job: MeetingJob;
  transcript: {
    meetingId: string;
    createdAt: string;
    segments: {
      start: number;
      end: number;
      speaker: string;
      text: string;
    }[];
  } | null;
  artifacts: {
    kind: string;
    mimeType: string;
    storagePath: string;
    generatedAt: string;
  }[];
  aiResults: {
    kind: string;
    model: string;
    outputJson: {
      title: string;
      summary: string;
      keyPoints: string[];
      decisions: string[];
      actionItems: {
        task: string;
        owner: string | null;
        dueDate: string | null;
        priority: "low" | "medium" | "high";
      }[];
      questions: string[];
      followUps: string[];
      participants: string[];
    };
    generatedAt: string;
  }[];
};

let authMode: "login" | "register" = "login";
let currentUser: User | null = null;

const authView = document.getElementById("auth-view") as HTMLElement;
const dashboardView = document.getElementById("dashboard-view") as HTMLElement;
const authForm = document.getElementById("auth-form") as HTMLFormElement;
const loginTab = document.getElementById("login-tab") as HTMLButtonElement;
const registerTab = document.getElementById(
  "register-tab",
) as HTMLButtonElement;
const authSubmit = document.getElementById("auth-submit") as HTMLButtonElement;
const authStatus = document.getElementById("auth-status") as HTMLElement;
const emailInput = document.getElementById("email") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const logoutButton = document.getElementById(
  "logout-button",
) as HTMLButtonElement;
const currentUserElem = document.getElementById("current-user") as HTMLElement;
const meetingForm = document.getElementById("meeting-form") as HTMLFormElement;
const urlInput = document.getElementById("url") as HTMLInputElement;
const statusElem = document.getElementById("status") as HTMLElement;
const jobsList = document.getElementById("jobs-list") as HTMLElement;
const refreshJobsButton = document.getElementById(
  "refresh-jobs",
) as HTMLButtonElement;
const resultDetail = document.getElementById("result-detail") as HTMLElement;

loginTab.addEventListener("click", () => setAuthMode("login"));
registerTab.addEventListener("click", () => setAuthMode("register"));
refreshJobsButton.addEventListener("click", () => loadJobs());

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authStatus.textContent =
    authMode === "login" ? "Logging in..." : "Creating account...";

  try {
    const payload = await api<{ user: User }>(`/auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({
        email: emailInput.value,
        password: passwordInput.value,
      }),
    });
    currentUser = payload.user;
    showDashboard();
    await loadJobs();
  } catch (err) {
    authStatus.textContent = getErrorMessage(err);
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" }).catch(() => undefined);
  currentUser = null;
  showAuth();
});

meetingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusElem.textContent = "Submitting...";

  try {
    const payload = await api<{
      message: string;
      jobId: string;
      authMode: string;
    }>("/submit-link", {
      method: "POST",
      body: JSON.stringify({ url: urlInput.value }),
    });
    statusElem.textContent = `${payload.message}. Job ${payload.jobId}. Auth: ${payload.authMode}.`;
    urlInput.value = "";
    await loadJobs();
  } catch (err) {
    statusElem.textContent = getErrorMessage(err);
  }
});

void boot();

async function boot() {
  try {
    const payload = await api<{ user: User | null }>("/auth/me");
    currentUser = payload.user;
  } catch {
    currentUser = null;
  }

  if (currentUser) {
    showDashboard();
    await loadJobs();
  } else {
    showAuth();
  }
}

function setAuthMode(mode: "login" | "register") {
  authMode = mode;
  loginTab.classList.toggle("active", mode === "login");
  registerTab.classList.toggle("active", mode === "register");
  authSubmit.textContent = mode === "login" ? "Login" : "Create Account";
  passwordInput.autocomplete =
    mode === "login" ? "current-password" : "new-password";
  authStatus.textContent = "";
}

function showAuth() {
  dashboardView.hidden = true;
  authView.hidden = false;
  setAuthMode("login");
}

function showDashboard() {
  authView.hidden = true;
  dashboardView.hidden = false;
  currentUserElem.textContent = currentUser ? currentUser.email : "";
  statusElem.textContent = "";
}

async function loadJobs() {
  jobsList.textContent = "Loading meetings...";
  try {
    const payload = await api<{ jobs: MeetingJob[] }>("/jobs");
    renderJobs(payload.jobs);
  } catch (err) {
    jobsList.textContent = getErrorMessage(err);
  }
}

function renderJobs(jobs: MeetingJob[]) {
  jobsList.innerHTML = "";
  if (jobs.length === 0) {
    jobsList.innerHTML = `<p class="muted">No meetings yet.</p>`;
    return;
  }

  for (const job of jobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-row";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(job.status)}</strong>
        <span>${escapeHtml(shortMeetingUrl(job.meetingUrl))}</span>
      </span>
      <small>${new Date(job.createdAt).toLocaleString()}</small>
    `;
    button.addEventListener("click", () => loadJobResult(job.id));
    jobsList.appendChild(button);
  }
}

async function loadJobResult(jobId: string) {
  resultDetail.className = "result-detail";
  resultDetail.textContent = "Loading results...";

  try {
    const results = await api<MeetingResults>(`/jobs/${jobId}`);
    renderResults(results);
  } catch (err) {
    resultDetail.textContent = getErrorMessage(err);
  }
}

function renderResults(results: MeetingResults) {
  const aiResult = results.aiResults.find(
    (result) => result.kind === "meeting_analysis",
  );
  const vttArtifact = results.artifacts.find(
    (artifact) => artifact.kind === "transcript_vtt",
  );

  resultDetail.innerHTML = `
    <div class="result-block">
      <h3>${escapeHtml(results.job.status)}</h3>
      <p class="muted">${escapeHtml(results.job.meetingUrl)}</p>
      ${
        results.job.meetingId
          ? `<p><strong>Meeting ID:</strong> ${escapeHtml(results.job.meetingId)}</p>`
          : `<p class="muted">Meeting ID is not available yet.</p>`
      }
    </div>

    <div class="result-block">
      <h3>AI Summary</h3>
      ${renderAiResult(aiResult)}
    </div>

    <div class="result-block">
      <h3>VTT Artifact</h3>
      ${
        vttArtifact
          ? `<p><a href="${escapeAttribute(vttArtifact.storagePath)}" target="_blank" rel="noreferrer">${escapeHtml(vttArtifact.storagePath)}</a></p>`
          : `<p class="muted">VTT artifact is not available yet.</p>`
      }
    </div>

    <div class="result-block">
      <h3>Transcript</h3>
      ${renderTranscript(results)}
    </div>
  `;
}

function renderAiResult(
  result: MeetingResults["aiResults"][number] | undefined,
) {
  if (!result) {
    return `<p class="muted">AI result is not available yet.</p>`;
  }

  const output = result.outputJson;
  return `
    <h4>${escapeHtml(output.title || "Untitled meeting")}</h4>
    <p>${escapeHtml(output.summary || "No summary generated.")}</p>
    ${renderList("Key Points", output.keyPoints)}
    ${renderList("Decisions", output.decisions)}
    ${renderActionItems(output.actionItems)}
    ${renderList("Questions", output.questions)}
    ${renderList("Follow Ups", output.followUps)}
    ${renderList("Participants", output.participants)}
    <p class="muted">Model: ${escapeHtml(result.model)}</p>
  `;
}

function renderTranscript(results: MeetingResults) {
  if (!results.transcript || results.transcript.segments.length === 0) {
    return `<p class="muted">Transcript is not available yet.</p>`;
  }

  return `
    <div class="transcript">
      ${results.transcript.segments
        .map(
          (segment) => `
            <p>
              <small>${segment.start}s-${segment.end}s</small>
              <strong>${escapeHtml(segment.speaker)}:</strong>
              ${escapeHtml(segment.text)}
            </p>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderList(title: string, items: string[]) {
  if (!items.length) return "";
  return `
    <h4>${escapeHtml(title)}</h4>
    <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  `;
}

function renderActionItems(
  actionItems: MeetingResults["aiResults"][number]["outputJson"]["actionItems"],
) {
  if (!actionItems.length) return "";
  return `
    <h4>Action Items</h4>
    <ul>
      ${actionItems
        .map(
          (item) => `
            <li>
              ${escapeHtml(item.task)}
              <span class="muted">
                ${item.owner ? `Owner: ${escapeHtml(item.owner)}. ` : ""}
                ${item.dueDate ? `Due: ${escapeHtml(item.dueDate)}. ` : ""}
                Priority: ${escapeHtml(item.priority)}.
              </span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

async function api<T = unknown>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload as T;
}

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong";
}

function shortMeetingUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
