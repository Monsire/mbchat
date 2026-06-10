const STORAGE_KEY = "chatbubble.sources.v4";
const LEGACY_STORAGE_KEY = "chatbubble.sources.v3";
const SETTINGS_KEY = "chatbubble.settings.v1";
const SECTIONS_KEY = "chatbubble.sections.v1";

const platforms = [
  { id: "twitch", label: "Twitch", placeholder: "twitch.tv/channel" },
  { id: "youtube", label: "YouTube", placeholder: "youtube.com/@channel/live" },
  { id: "kick", label: "Kick", placeholder: "kick.com/channel" },
  { id: "x", label: "X", placeholder: "x.com username or broadcast link" },
];

const platformIcons = {
  twitch: "./assets/twitch-logo.png",
  youtube: "./assets/youtube-logo.webp",
  kick: "./assets/kick-logo.avif",
  x: "./assets/x-logo.jpg",
};

const DEFAULT_SOURCE_COLOR = "#d7dde2";

const sourceList = document.querySelector("#source-list");
const feed = document.querySelector("#feed");
const resumeScrollButton = document.querySelector("#resume-scroll");
const userInfoPanel = document.querySelector("#user-info-panel");
const pollAdmin = document.querySelector("#poll-admin");
const obsStyleAdmin = document.querySelector("#obs-style-admin");
const spotlightBanner = document.querySelector("#spotlight-banner");
const adminSections = document.querySelector("#admin-sections");

let eventSource = null;
let sources = [];
let messages = [];
let statuses = {};
let settings = {};
let connectTimer = null;
let lastSourcesKey = "";
let isPinnedToLive = true;
let isRestoringScroll = false;
let isAddSourceChooserOpen = false;
let selectedMessageKey = "";
const OBS_STYLE_DEFAULTS = {
  fontSize: 18,
  borderWidth: 2,
  textColor: "#f2f2f2",
  accentColor: "#f2f2f2",
  background: "dark",
  showChat: true,
  chatHeader: true,
};

let poll = null;
let spotlight = null;
let obsStyle = null;
let viewers = {};
let pollDraft = { question: "", options: ["", ""], duration: 60 };
let pollAdminSignature = "";
let obsStyleBuilt = false;

function createSource(platform = "twitch", value = "") {
  return {
    id: `source_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    platform,
    value,
    label: "",
    usernameColor: "",
  };
}

function platformById(platformId) {
  return platforms.find((platform) => platform.id === platformId) || platforms[0];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMessageParts(message) {
  const parts = Array.isArray(message.parts) && message.parts.length
    ? message.parts
    : [{ type: "text", text: message.text || "" }];

  return parts
    .map((part) => {
      if (part.type === "emote" && part.url) {
        return `<img class="chat-emote" src="${escapeHtml(part.url)}" alt="${escapeHtml(part.name || "emote")}" title="${escapeHtml(part.name || "")}" loading="lazy" />`;
      }
      return escapeHtml(part.text || "");
    })
    .join("");
}

function sourceMeta(message) {
  return sources.find((source) => source.id === message.sourceId) || null;
}

function renderMessageSource(message) {
  const source = sourceMeta(message);
  const platform = message.platform;
  const icon = platformIcons[platform] || "";
  if (!icon) return "";
  const label = platformById(platform).label || platform;
  const sourceLabelText = String(source?.label || "").trim();
  return `
    <span class="message-source ${escapeHtml(platform)}" title="${escapeHtml(label)}">
      <img class="message-platform-icon" src="${escapeHtml(icon)}" alt="${escapeHtml(label)}" loading="lazy" />
      ${sourceLabelText ? `<span class="message-source-label">${escapeHtml(sourceLabelText)}</span>` : ""}
    </span>
  `;
}

function platformLabel(platform) {
  return platformById(platform).label || platform;
}

function safeColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : "";
}

function softenColor(value) {
  const color = safeColor(value);
  if (!color) return "";

  const hex = color.slice(1);
  const fullHex = hex.length === 3
    ? hex.split("").map((char) => char + char).join("")
    : hex.slice(0, 6);
  const base = [215, 221, 226];
  const rgb = [0, 2, 4].map((index, channel) => {
    const raw = parseInt(fullHex.slice(index, index + 2), 16);
    return Math.round(raw * 0.58 + base[channel] * 0.42);
  });

  return `rgb(${rgb.join(", ")})`;
}

function authorStyle(message) {
  const sourceColor = safeColor(sourceMeta(message)?.usernameColor);
  const softened = softenColor(sourceColor || message.color);
  return softened ? `color:${softened}` : "";
}

function activeSources() {
  return sources
    .map((source) => ({
      id: source.id,
      platform: source.platform,
      value: source.value.trim(),
      label: String(source.label || "").trim(),
      usernameColor: safeColor(source.usernameColor),
    }))
    .filter((source) => source.value);
}

function sourcesKey(sourceArray = activeSources()) {
  return JSON.stringify(sourceArray.map((source) => ({
    id: source.id,
    platform: source.platform,
    value: source.value,
    label: source.label || "",
    usernameColor: source.usernameColor || "",
  })));
}

function saveInputs() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
}

function migrateLegacySources() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)) || {};
    return Object.entries(legacy)
      .filter(([, value]) => String(value || "").trim())
      .map(([platform, value]) => createSource(platform, String(value)));
  } catch {
    return [];
  }
}

function loadInputs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) {
      sources = saved
        .filter((source) => source && source.id && source.platform)
        .map((source) => ({
          id: source.id,
          platform: platformById(source.platform).id,
          value: String(source.value || ""),
          label: String(source.label || ""),
          usernameColor: safeColor(source.usernameColor),
        }));
      return;
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }

  sources = migrateLegacySources();
  if (sources.length) saveInputs();
}

function loadSettings() {
  try {
    settings = { ...settings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch {
    localStorage.removeItem(SETTINGS_KEY);
  }
}

let sectionPrefs = { order: [], collapsed: {} };

function loadSectionPrefs() {
  try {
    sectionPrefs = { order: [], collapsed: {}, ...(JSON.parse(localStorage.getItem(SECTIONS_KEY)) || {}) };
  } catch {
    localStorage.removeItem(SECTIONS_KEY);
  }
}

function saveSectionPrefs() {
  localStorage.setItem(SECTIONS_KEY, JSON.stringify(sectionPrefs));
}

function applySectionPrefs() {
  if (!adminSections) return;
  const byId = new Map(
    Array.from(adminSections.querySelectorAll(".admin-section")).map((section) => [section.dataset.section, section]),
  );
  (sectionPrefs.order || []).forEach((id) => {
    const section = byId.get(id);
    if (section) adminSections.append(section);
  });
  byId.forEach((section, id) => {
    section.classList.toggle("collapsed", Boolean(sectionPrefs.collapsed?.[id]));
  });
}

function persistSectionOrder() {
  sectionPrefs.order = Array.from(adminSections.querySelectorAll(".admin-section"))
    .map((section) => section.dataset.section);
  saveSectionPrefs();
}

function renderAddSourceRow() {
  return `
    <div class="source-add-row ${isAddSourceChooserOpen ? "is-open" : ""}" aria-label="Add chat source">
      <button
        class="source-add-trigger"
        type="button"
        aria-expanded="${isAddSourceChooserOpen ? "true" : "false"}"
        tabindex="${isAddSourceChooserOpen ? "-1" : "0"}"
      >
        <span class="source-add-label">Add chat</span>
        <span class="add-plus" aria-hidden="true"></span>
      </button>
      <div class="source-add-icons" aria-label="Choose platform">
        ${platforms.map((platform) => `
          <button
            class="source-add-option"
            type="button"
            aria-label="Add ${escapeHtml(platform.label)} chat"
            title="Add ${escapeHtml(platform.label)}"
            data-platform="${escapeHtml(platform.id)}"
            tabindex="${isAddSourceChooserOpen ? "0" : "-1"}"
          >
            <img class="platform-icon" src="${escapeHtml(platformIcons[platform.id])}" alt="" />
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderSources() {
  const sourceRows = sources
    .map((source) => {
      const platform = platformById(source.platform);
      const status = statuses[source.id]?.status || "idle";
      return `
        <article class="source-row" data-source-id="${escapeHtml(source.id)}">
          <div class="source-platform">
            <img class="platform-icon" src="${escapeHtml(platformIcons[source.platform])}" alt="${escapeHtml(platform.label)}" title="${escapeHtml(platform.label)}" />
          </div>
          <input class="source-value" autocomplete="off" value="${escapeHtml(source.value)}" placeholder="${escapeHtml(platform.placeholder)}" />
          <input class="source-label" autocomplete="off" value="${escapeHtml(source.label || "")}" maxlength="18" placeholder="Label" aria-label="Chat label" />
          <button class="source-color" type="button" data-color="${escapeHtml(safeColor(source.usernameColor))}" style="background:${escapeHtml(safeColor(source.usernameColor) || DEFAULT_SOURCE_COLOR)}" aria-label="Username color" title="Username color"></button>
          <button class="remove-source" type="button" aria-label="Remove source" title="Remove source">&#10005;</button>
          <span class="source-state ${escapeHtml(status)}">${escapeHtml(status)}</span>
        </article>
      `;
    })
    .join("");

  sourceList.innerHTML = `${sourceRows}${renderAddSourceRow()}`;
  renderSourceStates();
}

function syncAddSourceRow() {
  const row = sourceList.querySelector(".source-add-row");
  if (!row) return;

  row.classList.toggle("is-open", isAddSourceChooserOpen);

  const trigger = row.querySelector(".source-add-trigger");
  if (trigger) {
    trigger.setAttribute("aria-expanded", String(isAddSourceChooserOpen));
    trigger.tabIndex = isAddSourceChooserOpen ? -1 : 0;
  }

  row.querySelectorAll(".source-add-option").forEach((option) => {
    option.tabIndex = isAddSourceChooserOpen ? 0 : -1;
  });
}

function renderStatuses() {
}

function formatViewers(count) {
  return Number(count).toLocaleString("en-US");
}

function renderSourceStates() {
  sourceList.querySelectorAll(".source-row").forEach((row) => {
    const sourceId = row.dataset.sourceId;
    const status = statuses[sourceId]?.status || "idle";
    const state = row.querySelector(".source-state");
    if (!state) return;
    const count = viewers[sourceId];
    state.className = `source-state ${status}`;
    state.innerHTML = `${escapeHtml(status)}${Number.isFinite(count)
      ? `<span class="source-viewers">${formatViewers(count)} watching</span>`
      : ""}`;
  });
  renderSourcesTotal();
}

function renderSourcesTotal() {
  const total = document.querySelector("#sources-total");
  if (!total) return;
  const counts = Object.values(viewers).filter((value) => Number.isFinite(value));
  total.textContent = counts.length
    ? `${formatViewers(counts.reduce((sum, value) => sum + value, 0))} watching`
    : "";
}

function isAtLiveEdge() {
  return Math.abs(feed.scrollTop) <= 6;
}

function setPinnedToLive(value) {
  isPinnedToLive = value;
  if (resumeScrollButton) resumeScrollButton.hidden = value;
}

function jumpToLive() {
  setPinnedToLive(true);
  feed.scrollTop = 0;
}

function messageKey(message, index) {
  const sourceId = message.sourceId || message.platform;
  return message.id
    ? `${sourceId}:id:${message.id}`
    : `${sourceId}:${message.createdAt}:${message.author}:${message.text}:${index}`;
}

function selectedMessage() {
  return messages.find((message, index) => messageKey(message, index) === selectedMessageKey) || null;
}

function sourceLabel(message) {
  const source = sources.find((item) => item.id === message.sourceId);
  const customLabel = String(source?.label || "").trim();
  return customLabel
    ? `${customLabel} · ${source?.value || message.sourceId || platformLabel(message.platform)}`
    : source?.value || message.sourceId || platformLabel(message.platform);
}

function formatMessageTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

let userLogs = null;
let userPanelSignature = "";
let userPanelAnchorY = 64;
const avatarRequests = new Map();

function positionUserPanel() {
  if (!userInfoPanel || userInfoPanel.hidden) return;
  const surface = userInfoPanel.parentElement;
  if (!surface) return;
  const maxTop = surface.clientHeight - userInfoPanel.offsetHeight - 12;
  userInfoPanel.style.top = `${Math.min(Math.max(12, userPanelAnchorY), Math.max(12, maxTop))}px`;
}

function requestAvatar(platform, author, authorUrl) {
  if (!["twitch", "kick"].includes(platform)) return Promise.resolve("");
  const value = (String(authorUrl || "").split("/").filter(Boolean).pop() || String(author || "")).toLowerCase();
  if (!value) return Promise.resolve("");
  const key = `${platform}:${value}`;
  const ttl = platform === "kick" ? 10 * 60 * 1000 : Infinity;
  const cached = avatarRequests.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.promise;
  const promise = fetch(`/api/avatar?${new URLSearchParams({ platform, value })}`)
    .then((response) => response.json())
    .then((data) => {
      const avatar = String(data.avatar || "");
      if (!avatar) avatarRequests.delete(key);
      return avatar;
    })
    .catch(() => {
      avatarRequests.delete(key);
      return "";
    });
  avatarRequests.set(key, { promise, at: Date.now() });
  return promise;
}

function hydrateAvatar(message) {
  if (!message || message.avatar) return;
  requestAvatar(message.platform, message.author, message.authorUrl).then((avatar) => {
    if (!avatar) return;
    const authorKey = String(message.author || "").toLowerCase();
    messages.forEach((item) => {
      if (item.platform === message.platform && String(item.author || "").toLowerCase() === authorKey && !item.avatar) {
        item.avatar = avatar;
      }
    });
    if (userLogs && userLogs.author.toLowerCase() === authorKey && !userLogs.avatar) {
      userLogs.avatar = avatar;
    }
    userPanelSignature = "";
    renderUserInfoPanel();
  });
}

function userCardAvatar(avatar, author) {
  return avatar
    ? `<img class="user-card-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" />`
    : `<span class="user-card-avatar fallback">${escapeHtml((author || "?").slice(0, 1).toUpperCase())}</span>`;
}

function userCardName(author, authorUrl) {
  const name = escapeHtml(author || "Unknown user");
  const url = String(authorUrl || "");
  return /^https:\/\//.test(url)
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
    : name;
}

async function openUserLogs(message) {
  userLogs = {
    author: message.author || "",
    authorUrl: message.authorUrl || "",
    sourceId: message.sourceId || "",
    avatar: message.avatar || "",
    loading: true,
    messages: [],
  };
  hydrateAvatar(message);
  renderUserInfoPanel();

  try {
    const params = new URLSearchParams({ sourceId: userLogs.sourceId, author: userLogs.author });
    const response = await fetch(`/api/user-messages?${params}`);
    const data = await response.json();
    if (!userLogs) return;
    userLogs.messages = Array.isArray(data.messages) ? data.messages : [];
  } catch {
    // Leave the log empty if the server is unreachable.
  }
  if (userLogs) {
    userLogs.loading = false;
    renderUserInfoPanel();
  }
}

function appendToOpenUserLogs(message) {
  if (!userLogs || userLogs.loading) return;
  if (message.sourceId !== userLogs.sourceId) return;
  if (String(message.author || "").toLowerCase() !== userLogs.author.toLowerCase()) return;
  userLogs.messages = [message, ...userLogs.messages].slice(0, 500);
}

function renderUserLogsPanel() {
  const count = userLogs.messages.length;
  const spotlighted = isSpotlighted(userLogs);
  const entries = userLogs.messages
    .slice()
    .reverse()
    .map((message) => `
      <div class="user-log-entry">
        <span class="user-log-time">${escapeHtml(formatMessageTime(message.createdAt))}</span>
        <span class="user-log-text">${message.event ? `<span class="event-label">${escapeHtml(message.event.label)}</span> ` : ""}${renderMessageParts(message)}</span>
      </div>
    `)
    .join("");

  const previousList = userInfoPanel.querySelector(".user-log-list");
  const wasNearBottom = !previousList ||
    previousList.scrollTop + previousList.clientHeight >= previousList.scrollHeight - 30;
  const previousScrollTop = previousList ? previousList.scrollTop : 0;

  userInfoPanel.hidden = false;
  userInfoPanel.innerHTML = `
    <button class="user-card-close" type="button" aria-label="Close user info">&#10005;</button>
    <div class="user-card-head">
      ${userCardAvatar(userLogs.avatar, userLogs.author)}
      <div class="user-card-title">
        <strong>${userCardName(userLogs.author, userLogs.authorUrl)}</strong>
        <span>${userLogs.loading ? "Loading log…" : `${count} message${count === 1 ? "" : "s"} this stream`}</span>
      </div>
    </div>
    <div class="user-log-list">
      ${entries || (userLogs.loading ? "" : '<div class="user-log-empty">No messages stored yet.</div>')}
    </div>
    <div class="user-card-actions">
      <button class="user-card-back" type="button">Back</button>
      <button class="user-card-spotlight ${spotlighted ? "active" : ""}" type="button">${spotlighted ? "Stop spotlight" : "Spotlight"}</button>
    </div>
  `;

  const list = userInfoPanel.querySelector(".user-log-list");
  if (list) list.scrollTop = wasNearBottom ? list.scrollHeight : previousScrollTop;
}

function renderUserInfoPanel() {
  if (!userInfoPanel) return;

  if (userLogs) {
    const signature = `logs:${userLogs.author}:${userLogs.sourceId}:${userLogs.loading}:${userLogs.messages.length}:${isSpotlighted(userLogs)}`;
    if (signature === userPanelSignature) {
      positionUserPanel();
      return;
    }
    userPanelSignature = signature;
    renderUserLogsPanel();
    positionUserPanel();
    return;
  }

  const message = selectedMessage();

  if (!message) {
    userPanelSignature = "";
    userInfoPanel.hidden = true;
    userInfoPanel.innerHTML = "";
    return;
  }

  const badges = Array.isArray(message.badges) ? message.badges.filter(Boolean) : [];
  const badgeHtml = badges.slice(0, 8).map(renderBadge).join("");
  const platform = platformLabel(message.platform);

  const signature = `card:${selectedMessageKey}:${sourceLabel(message)}`;
  if (signature === userPanelSignature) {
    positionUserPanel();
    return;
  }
  userPanelSignature = signature;

  userInfoPanel.hidden = false;
  userInfoPanel.innerHTML = `
    <button class="user-card-close" type="button" aria-label="Close user info">&#10005;</button>
    <div class="user-card-head">
      ${userCardAvatar(message.avatar, message.author)}
      <div class="user-card-title">
        <strong>${userCardName(message.author, message.authorUrl)}</strong>
        <span>${escapeHtml(platform)} · ${escapeHtml(sourceLabel(message))}</span>
      </div>
    </div>
    ${badgeHtml ? `
      <div class="user-card-badges" aria-label="Badges">
        ${badgeHtml}
      </div>
    ` : ""}
    <div class="user-card-message">${renderMessageParts(message)}</div>
    <div class="user-card-actions">
      <button class="user-card-logs" type="button">Message logs</button>
    </div>
  `;
  positionUserPanel();
}

function renderBadge(badge) {
  if (!badge || typeof badge !== "object" || !badge.url) return "";
  const label = escapeHtml(badge.label || "badge");
  return `<img class="user-card-badge" src="${escapeHtml(badge.url)}" alt="${label}" title="${label}" loading="lazy" />`;
}

function isSpotlighted(message) {
  return Boolean(
    spotlight &&
    message &&
    spotlight.sourceId === message.sourceId &&
    String(spotlight.author || "").toLowerCase() === String(message.author || "").toLowerCase(),
  );
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast(data.error || "Request failed");
    }
    return response.ok;
  } catch {
    showToast("Could not reach chat server");
    return false;
  }
}

function renderPollForm() {
  const canRemove = pollDraft.options.length > 2;
  pollAdmin.innerHTML = `
    <form class="poll-form" id="poll-form">
      <input class="poll-question-input" autocomplete="off" maxlength="140" placeholder="Poll question" value="${escapeHtml(pollDraft.question)}" />
      <div class="poll-form-options">
        ${pollDraft.options.map((option, index) => `
          <div class="poll-form-option">
            <span class="poll-option-key">${index + 1}</span>
            <input data-option-index="${index}" autocomplete="off" maxlength="60" placeholder="Option ${index + 1}" value="${escapeHtml(option)}" />
            ${canRemove ? `<button class="poll-remove-option" type="button" data-remove-option="${index}" aria-label="Remove option">&#10005;</button>` : ""}
          </div>
        `).join("")}
      </div>
      <div class="poll-form-foot">
        <button class="poll-add-option" type="button" ${pollDraft.options.length >= 6 ? "disabled" : ""}>+ Option</button>
        <label class="poll-duration-label">
          <input class="poll-duration" type="number" min="10" max="3600" value="${escapeHtml(String(pollDraft.duration))}" />
          <span>sec</span>
        </label>
        <button class="poll-start" type="submit">Start poll</button>
      </div>
    </form>
  `;
}

function renderPollLive() {
  pollAdmin.innerHTML = `
    <div class="poll-live">
      <div id="poll-admin-widget"></div>
      <div class="poll-controls">
        <button class="poll-mode ${poll.displayMode === "bars" ? "active" : ""}" type="button" data-mode="bars">Bars</button>
        <button class="poll-mode ${poll.displayMode === "pie" ? "active" : ""}" type="button" data-mode="pie">Pie</button>
        ${poll.status === "active"
          ? '<button class="poll-end" type="button">End now</button>'
          : '<button class="poll-clear" type="button">New poll</button>'}
      </div>
    </div>
  `;
}

function renderPollAdmin() {
  if (!pollAdmin) return;
  const signature = poll
    ? `live:${poll.id}:${poll.status}:${poll.displayMode}:${poll.options.length}`
    : `form:${pollDraft.options.length}`;
  if (signature !== pollAdminSignature) {
    pollAdminSignature = signature;
    if (poll) renderPollLive();
    else renderPollForm();
  }
  if (poll) window.PollWidget.render(pollAdmin.querySelector("#poll-admin-widget"), poll);
}

function renderSpotlightBanner() {
  if (!spotlightBanner) return;
  if (!spotlight) {
    spotlightBanner.hidden = true;
    spotlightBanner.innerHTML = "";
    return;
  }

  const icon = platformIcons[spotlight.platform] || "";
  const entries = (spotlight.messages || [])
    .slice()
    .reverse()
    .map((message) => `
      <div class="obs-spotlight-msg">
        <span class="obs-spotlight-time">${escapeHtml(formatMessageTime(message.createdAt))}</span>
        <span class="obs-spotlight-text">${message.event ? `<span class="event-label">${escapeHtml(message.event.label)}</span> ` : ""}${renderMessageParts(message)}</span>
      </div>
    `)
    .join("");

  const previousList = spotlightBanner.querySelector(".obs-spotlight-messages");
  const wasNearBottom = !previousList ||
    previousList.scrollTop + previousList.clientHeight >= previousList.scrollHeight - 30;
  const previousScrollTop = previousList ? previousList.scrollTop : 0;

  spotlightBanner.hidden = false;
  spotlightBanner.innerHTML = `
    <div class="spotlight-preview-label">
      <span class="spotlight-live-dot">Live on stream</span>
      <button class="spotlight-stop" type="button">Stop spotlight</button>
    </div>
    <section class="obs-spotlight spotlight-preview">
      <div class="obs-spotlight-head">
        ${spotlight.avatar
          ? `<img class="obs-spotlight-avatar" src="${escapeHtml(spotlight.avatar)}" alt="" loading="lazy" />`
          : `<span class="obs-spotlight-avatar fallback">${escapeHtml((spotlight.author || "?").slice(0, 1).toUpperCase())}</span>`}
        <div class="obs-spotlight-title">
          <strong>${escapeHtml(spotlight.author)}</strong>
          <span>
            ${icon ? `<img class="message-platform-icon" src="${escapeHtml(icon)}" alt="" />` : ""}
            Spotlight
          </span>
        </div>
      </div>
      <div class="obs-spotlight-messages">
        ${entries || '<div class="obs-spotlight-empty">Waiting for their next message…</div>'}
      </div>
    </section>
  `;

  const list = spotlightBanner.querySelector(".obs-spotlight-messages");
  if (list) list.scrollTop = wasNearBottom ? list.scrollHeight : previousScrollTop;
}

function renderObsStyleAdmin() {
  if (!obsStyleAdmin || !obsStyle) return;

  if (!obsStyleBuilt) {
    obsStyleBuilt = true;
    obsStyleAdmin.innerHTML = `
      <div class="obs-style-form">
        <label class="obs-style-field">
          <span>Text size</span>
          <input type="range" min="10" max="48" data-style="fontSize" />
          <span class="obs-style-value" data-style-value="fontSize"></span>
        </label>
        <label class="obs-style-field">
          <span>Stroke width</span>
          <input type="range" min="1" max="10" data-style="borderWidth" />
          <span class="obs-style-value" data-style-value="borderWidth"></span>
        </label>
        <div class="obs-style-field">
          <span>Text color</span>
          <button class="color-swatch" type="button" data-style="textColor" aria-label="Text color" title="Text color"></button>
        </div>
        <div class="obs-style-field">
          <span>Accent color</span>
          <button class="color-swatch" type="button" data-style="accentColor" aria-label="Accent color" title="Accent color"></button>
        </div>
        <label class="obs-style-field">
          <span>Background</span>
          <select data-style="background">
            <option value="dark">Dark</option>
            <option value="transparent">Transparent (overlay)</option>
          </select>
        </label>
        <label class="obs-style-field obs-style-check">
          <input type="checkbox" data-style="showChat" />
          <span>Show chat feed</span>
        </label>
        <label class="obs-style-field obs-style-check">
          <input type="checkbox" data-style="chatHeader" />
          <span>Chat title bar</span>
        </label>
      </div>
    `;
  }

  if (!obsStyleAdmin.contains(document.activeElement)) {
    obsStyleAdmin.querySelector('[data-style="fontSize"]').value = obsStyle.fontSize;
    obsStyleAdmin.querySelector('[data-style="borderWidth"]').value = obsStyle.borderWidth ?? 2;
    obsStyleAdmin.querySelector('[data-style="background"]').value = obsStyle.background;
    obsStyleAdmin.querySelector('[data-style="showChat"]').checked = obsStyle.showChat;
    obsStyleAdmin.querySelector('[data-style="chatHeader"]').checked = obsStyle.chatHeader !== false;
  }
  ["textColor", "accentColor"].forEach((key) => {
    const swatch = obsStyleAdmin.querySelector(`[data-style="${key}"]`);
    if (!swatch) return;
    swatch.dataset.color = obsStyle[key];
    swatch.style.background = obsStyle[key];
  });
  obsStyleAdmin.querySelector('[data-style-value="fontSize"]').textContent = `${obsStyle.fontSize}px`;
  obsStyleAdmin.querySelector('[data-style-value="borderWidth"]').textContent = `${obsStyle.borderWidth ?? 2}px`;
}

function normalizeHexColor(value) {
  let hex = String(value || "").trim().toLowerCase();
  if (!hex.startsWith("#")) hex = `#${hex}`;
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    hex = `#${[...hex.slice(1)].map((char) => char + char).join("")}`;
  }
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : "";
}

const COLOR_PICKER_PALETTE = [
  "#eeeeee", "#c9c9c9", "#9d9d9d", "#6f6f6f", "#454545", "#0d0d0d",
  "#f87171", "#fb923c", "#fbbf24", "#fde047", "#4ade80", "#22c55e",
  "#2dd4bf", "#5eead4", "#60a5fa", "#3b82f6", "#a78bfa", "#8b5cf6",
  "#f472b6", "#fb7185", "#d7dde2", "#bfdbfe", "#fecaca", "#d9f99d",
];

let activeColorPopover = null;
let activeColorAnchor = null;

function closeColorPopover() {
  activeColorPopover?.remove();
  activeColorPopover = null;
  activeColorAnchor = null;
}

function openColorPopover(anchor, currentColor, { onPick, onReset }) {
  if (activeColorAnchor === anchor) {
    closeColorPopover();
    return;
  }
  closeColorPopover();

  const selected = String(currentColor || "").toLowerCase();
  const popover = document.createElement("div");
  popover.className = "color-popover";
  popover.innerHTML = `
    <div class="color-popover-grid">
      ${COLOR_PICKER_PALETTE.map((color) => `
        <button
          class="color-popover-swatch ${color === selected ? "selected" : ""}"
          type="button"
          data-color="${color}"
          style="background:${color}"
          aria-label="${color}"
          title="${color}"
        ></button>
      `).join("")}
    </div>
    <div class="color-popover-foot">
      <input class="color-popover-hex" type="text" maxlength="7" autocomplete="off" spellcheck="false" value="${escapeHtml(selected)}" placeholder="#hex" aria-label="Hex color code" />
      <button class="color-popover-reset" type="button">Reset</button>
    </div>
  `;
  document.body.append(popover);

  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.left - popRect.width + rect.width), window.innerWidth - popRect.width - 8);
  const top = rect.bottom + 8 + popRect.height > window.innerHeight
    ? Math.max(8, rect.top - popRect.height - 8)
    : rect.bottom + 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  popover.addEventListener("click", (event) => {
    const swatch = event.target.closest(".color-popover-swatch");
    if (swatch) {
      onPick(swatch.dataset.color);
      closeColorPopover();
      return;
    }
    if (event.target.closest(".color-popover-reset")) {
      onReset();
      closeColorPopover();
    }
  });

  popover.addEventListener("input", (event) => {
    if (!(event.target instanceof Element) || !event.target.matches(".color-popover-hex")) return;
    const hex = normalizeHexColor(event.target.value);
    if (hex) onPick(hex);
  });

  popover.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      closeColorPopover();
    } else if (event.key === "Escape") {
      closeColorPopover();
    }
  });

  activeColorPopover = popover;
  activeColorAnchor = anchor;
  popover.querySelector(".color-popover-hex")?.focus();
}

document.addEventListener("mousedown", (event) => {
  if (!activeColorPopover || !(event.target instanceof Element)) return;
  if (activeColorPopover.contains(event.target)) return;
  if (event.target.closest(".color-swatch, .source-color") === activeColorAnchor) return;
  closeColorPopover();
});

function getScrollAnchor() {
  if (isPinnedToLive) return null;

  const feedRect = feed.getBoundingClientRect();
  const anchor = Array.from(feed.querySelectorAll(".message[data-message-key]"))
    .find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > feedRect.top && rect.top < feedRect.bottom;
    });

  return anchor
    ? { key: anchor.getAttribute("data-message-key"), top: anchor.getBoundingClientRect().top }
    : null;
}

function restoreScrollAnchor(anchor) {
  if (!anchor) return false;

  const element = Array.from(feed.querySelectorAll(".message[data-message-key]"))
    .find((candidate) => candidate.getAttribute("data-message-key") === anchor.key);
  if (!element) return false;

  feed.scrollTop += element.getBoundingClientRect().top - anchor.top;
  return true;
}

const eventTags = {
  bits: "Bits",
  superchat: "Super Chat",
  sub: "Sub",
  giftsub: "Gift Sub",
  membership: "Member",
};

function renderEventMessage(message, key) {
  const hasText = Boolean(String(message.text || "").trim());
  return `
      <article
        class="message event ${escapeHtml(message.platform)} ${key === selectedMessageKey ? "selected" : ""}"
        data-message-key="${escapeHtml(key)}"
        role="button"
        tabindex="0"
        aria-label="Show info for ${escapeHtml(message.author || "user")}"
      >
        ${renderMessageSource(message)}
        <span class="event-tag">${escapeHtml(eventTags[message.event?.type] || "Event")}</span>
        <span class="message-author" style="${authorStyle(message)}">${escapeHtml(message.author)}</span>
        <span class="event-label">${escapeHtml(message.event?.label || "")}</span>
        ${hasText ? `<span class="message-text event-text">${renderMessageParts(message)}</span>` : ""}
      </article>
    `;
}

function renderFeed() {
  const previousScrollTop = feed.scrollTop;
  const scrollAnchor = getScrollAnchor();

  if (!messages.length) {
    feed.innerHTML = '<div class="empty">Waiting for chat.</div>';
    renderUserInfoPanel();
    jumpToLive();
    return;
  }

  feed.innerHTML = messages
    .slice(0, 100)
    .map((message, index) => {
      const key = messageKey(message, index);
      if (message.kind === "event") return renderEventMessage(message, key);
      return `
      <article
        class="message ${escapeHtml(message.platform)} ${key === selectedMessageKey ? "selected" : ""}"
        data-message-key="${escapeHtml(key)}"
        role="button"
        tabindex="0"
        aria-label="Show info for ${escapeHtml(message.author || "user")}"
      >
        ${renderMessageSource(message)}
        <span class="message-author" style="${authorStyle(message)}">${escapeHtml(message.author)}</span><span class="message-separator">:</span>
        <span class="message-text">${renderMessageParts(message)}</span>
      </article>
    `;
    })
    .join("");

  renderUserInfoPanel();

  if (isPinnedToLive) {
    feed.scrollTop = 0;
  } else {
    isRestoringScroll = true;
    if (!restoreScrollAnchor(scrollAnchor)) {
      feed.scrollTop = previousScrollTop;
    }
    window.requestAnimationFrame(() => {
      isRestoringScroll = false;
    });
  }
}

function markSourceLive(sourceId, platform) {
  if (!sourceId) return;
  if (statuses[sourceId]?.status !== "connected") {
    statuses[sourceId] = { sourceId, platform, status: "connected" };
    renderStatuses();
    renderSourceStates();
  }
}

function showToast(text) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 1800);
}

function statusArrayToMap(statusArray = []) {
  const next = {};
  statusArray.forEach((status) => {
    if (status?.sourceId) next[status.sourceId] = status;
  });
  return next;
}

function connectEventStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("ready", (event) => {
    const data = JSON.parse(event.data);
    statuses = statusArrayToMap(data.statuses || []);
    messages = data.recentMessages || [];
    lastSourcesKey = sourcesKey(data.sources || []);
    poll = data.poll || null;
    spotlight = data.spotlight || null;
    obsStyle = data.obsStyle || null;
    viewers = data.viewers || {};
    renderStatuses();
    renderSources();
    renderFeed();
    renderPollAdmin();
    renderSpotlightBanner();
    renderObsStyleAdmin();
  });

  eventSource.addEventListener("reset", () => {
    messages = [];
    statuses = {};
    lastSourcesKey = "";
    poll = null;
    spotlight = null;
    viewers = {};
    renderStatuses();
    renderSources();
    renderFeed();
    renderPollAdmin();
    renderSpotlightBanner();
  });

  eventSource.addEventListener("poll", (event) => {
    poll = JSON.parse(event.data);
    renderPollAdmin();
  });

  eventSource.addEventListener("spotlight", (event) => {
    spotlight = JSON.parse(event.data);
    renderSpotlightBanner();
    renderUserInfoPanel();
  });

  eventSource.addEventListener("obs-style", (event) => {
    obsStyle = JSON.parse(event.data);
    renderObsStyleAdmin();
  });

  eventSource.addEventListener("source-reset", (event) => {
    const data = JSON.parse(event.data);
    messages = messages.filter((message) => message.sourceId !== data.sourceId);
    delete statuses[data.sourceId];
    delete viewers[data.sourceId];
    renderStatuses();
    renderSourceStates();
    renderFeed();
  });

  eventSource.addEventListener("viewers", (event) => {
    const data = JSON.parse(event.data);
    if (!data.sourceId) return;
    if (Number.isFinite(Number(data.count)) && data.count !== null) {
      viewers[data.sourceId] = Number(data.count);
    } else {
      delete viewers[data.sourceId];
    }
    renderSourceStates();
  });

  eventSource.addEventListener("status", (event) => {
    const data = JSON.parse(event.data);
    if (data.sourceId) statuses[data.sourceId] = data;
    renderStatuses();
    renderSourceStates();
    if (data.status === "error") showToast(`${data.platform}: ${data.detail}`);
  });

  eventSource.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    markSourceLive(message.sourceId, message.platform);
    messages = [message, ...messages].slice(0, 100);
    appendToOpenUserLogs(message);
    renderFeed();
  });
}

function scheduleAutoConnect(delay = 1600) {
  window.clearTimeout(connectTimer);
  connectTimer = window.setTimeout(autoConnect, delay);
}

async function autoConnect() {
  saveInputs();
  const nextSources = activeSources();
  const nextKey = sourcesKey(nextSources);
  if (nextKey === lastSourcesKey) return;

  if (!nextSources.length) {
    await fetch("/api/stop", { method: "POST" });
    statuses = {};
    messages = [];
    lastSourcesKey = "";
    renderStatuses();
    renderSources();
    renderFeed();
    return;
  }

  nextSources.forEach((source) => {
    const currentStatus = statuses[source.id]?.status;
    if (!currentStatus || currentStatus === "idle" || statuses[source.id]?.detail !== source.value) {
      statuses[source.id] = {
        sourceId: source.id,
        platform: source.platform,
        status: "connecting",
        detail: source.value,
      };
    }
  });
  renderStatuses();
  renderSourceStates();

  lastSourcesKey = nextKey;
  try {
    const response = await fetch("/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: nextSources }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast(data.error || "Could not start chat");
      lastSourcesKey = "";
    }
  } catch {
    showToast("Could not reach chat server");
    lastSourcesKey = "";
  }
}

function updateSource(sourceId, patch, options = {}) {
  sources = sources.map((source) => source.id === sourceId ? { ...source, ...patch } : source);
  saveInputs();
  if (options.render !== false) renderSources();
  scheduleAutoConnect(options.delay);
}

function addSource(platform = "twitch") {
  const source = createSource(platform);
  sources = [...sources, source];
  isAddSourceChooserOpen = false;
  saveInputs();
  renderSources();
  window.requestAnimationFrame(() => {
    Array.from(sourceList.querySelectorAll(".source-row"))
      .find((row) => row.dataset.sourceId === source.id)
      ?.querySelector(".source-value")
      ?.focus();
  });
}

sourceList.addEventListener("input", (event) => {
  const row = event.target.closest(".source-row");
  if (!row) return;

  if (event.target.matches(".source-value")) {
    updateSource(row.dataset.sourceId, { value: event.target.value }, { render: false, delay: 1600 });
  } else if (event.target.matches(".source-label")) {
    updateSource(row.dataset.sourceId, { label: event.target.value }, { render: false, delay: 250 });
    renderFeed();
    renderUserInfoPanel();
  }
});

sourceList.addEventListener("keydown", (event) => {
  const row = event.target.closest(".source-row");
  if (!row || !event.target.matches(".source-value") || event.key !== "Enter") return;

  event.preventDefault();
  updateSource(row.dataset.sourceId, { value: event.target.value }, { render: false, delay: 0 });
});

sourceList.addEventListener("click", (event) => {
  const addOption = event.target.closest(".source-add-option");
  if (addOption) {
    addSource(addOption.dataset.platform);
    return;
  }

  if (event.target.closest(".source-add-trigger")) {
    isAddSourceChooserOpen = !isAddSourceChooserOpen;
    syncAddSourceRow();
    return;
  }

  const row = event.target.closest(".source-row");
  if (!row) return;

  const colorButton = event.target.closest(".source-color");
  if (colorButton) {
    const sourceId = row.dataset.sourceId;
    const applyColor = (hex) => {
      colorButton.dataset.color = hex;
      colorButton.style.background = hex || DEFAULT_SOURCE_COLOR;
      updateSource(sourceId, { usernameColor: hex }, { render: false, delay: 250 });
      renderFeed();
      renderUserInfoPanel();
    };
    openColorPopover(colorButton, colorButton.dataset.color || "", {
      onPick: applyColor,
      onReset: () => applyColor(""),
    });
    return;
  }

  if (event.target.matches(".remove-source")) {
    sources = sources.filter((source) => source.id !== row.dataset.sourceId);
    saveInputs();
    renderSources();
    scheduleAutoConnect(80);
  }
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".source-add-row")) {
    if (isAddSourceChooserOpen) {
      isAddSourceChooserOpen = false;
      syncAddSourceRow();
    }
  }
});

feed.addEventListener("scroll", () => {
  if (isRestoringScroll) return;
  setPinnedToLive(isAtLiveEdge());
}, { passive: true });

feed.addEventListener("click", (event) => {
  const message = event.target.closest(".message[data-message-key]");
  if (!message) return;
  selectedMessageKey = message.dataset.messageKey || "";
  userLogs = null;
  const surfaceRect = userInfoPanel.parentElement.getBoundingClientRect();
  userPanelAnchorY = event.clientY - surfaceRect.top + 10;
  hydrateAvatar(selectedMessage());
  renderFeed();
});

feed.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const message = event.target.closest(".message[data-message-key]");
  if (!message) return;
  event.preventDefault();
  selectedMessageKey = message.dataset.messageKey || "";
  userLogs = null;
  const surfaceRect = userInfoPanel.parentElement.getBoundingClientRect();
  userPanelAnchorY = message.getBoundingClientRect().top - surfaceRect.top + 10;
  hydrateAvatar(selectedMessage());
  renderFeed();
});

adminSections?.addEventListener("click", (event) => {
  const head = event.target.closest(".admin-section-head");
  if (!head) return;
  const section = head.closest(".admin-section");
  const collapsed = section.classList.toggle("collapsed");
  sectionPrefs.collapsed = { ...sectionPrefs.collapsed, [section.dataset.section]: collapsed };
  saveSectionPrefs();
});

let draggedSection = null;

adminSections?.addEventListener("dragstart", (event) => {
  const head = event.target.closest(".admin-section-head");
  if (!head) {
    event.preventDefault();
    return;
  }
  draggedSection = head.closest(".admin-section");
  draggedSection.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedSection.dataset.section);
});

adminSections?.addEventListener("dragover", (event) => {
  if (!draggedSection) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const target = event.target.closest(".admin-section");
  if (!target || target === draggedSection) return;
  const rect = target.getBoundingClientRect();
  const placeBefore = event.clientY < rect.top + rect.height / 2;
  adminSections.insertBefore(draggedSection, placeBefore ? target : target.nextSibling);
});

adminSections?.addEventListener("drop", (event) => event.preventDefault());

adminSections?.addEventListener("dragend", () => {
  if (!draggedSection) return;
  draggedSection.classList.remove("dragging");
  draggedSection = null;
  persistSectionOrder();
});

pollAdmin?.addEventListener("input", (event) => {
  if (event.target.matches(".poll-question-input")) {
    pollDraft.question = event.target.value;
  } else if (event.target.matches("[data-option-index]")) {
    pollDraft.options[Number(event.target.dataset.optionIndex)] = event.target.value;
  } else if (event.target.matches(".poll-duration")) {
    pollDraft.duration = event.target.value;
  }
});

pollAdmin?.addEventListener("click", (event) => {
  if (event.target.closest(".poll-add-option")) {
    if (pollDraft.options.length < 6) {
      pollDraft.options.push("");
      pollAdminSignature = "";
      renderPollAdmin();
    }
    return;
  }

  const removeButton = event.target.closest("[data-remove-option]");
  if (removeButton) {
    pollDraft.options.splice(Number(removeButton.dataset.removeOption), 1);
    pollAdminSignature = "";
    renderPollAdmin();
    return;
  }

  const modeButton = event.target.closest(".poll-mode");
  if (modeButton) {
    postJson("/api/poll/display", { mode: modeButton.dataset.mode });
    return;
  }
  if (event.target.closest(".poll-end")) {
    postJson("/api/poll/stop");
    return;
  }
  if (event.target.closest(".poll-clear")) {
    postJson("/api/poll/clear");
  }
});

pollAdmin?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const options = pollDraft.options.map((option) => option.trim()).filter(Boolean);
  if (options.length < 2) {
    showToast("A poll needs at least 2 options");
    return;
  }
  const ok = await postJson("/api/poll", {
    question: pollDraft.question.trim(),
    options,
    duration: Number(pollDraft.duration) || 60,
    displayMode: poll?.displayMode || "bars",
  });
  if (ok) pollDraft = { question: "", options: ["", ""], duration: pollDraft.duration };
});

spotlightBanner?.addEventListener("click", (event) => {
  if (event.target.closest(".spotlight-stop")) postJson("/api/spotlight/stop");
});

// Mirror the streamer's scroll position to the stream view as a 0..1 fraction.
let spotlightScrollTimer = null;
spotlightBanner?.addEventListener("scroll", (event) => {
  if (!(event.target instanceof Element) || !event.target.matches(".obs-spotlight-messages")) return;
  window.clearTimeout(spotlightScrollTimer);
  spotlightScrollTimer = window.setTimeout(() => {
    const list = spotlightBanner.querySelector(".obs-spotlight-messages");
    if (!list) return;
    const range = list.scrollHeight - list.clientHeight;
    postJson("/api/spotlight/scroll", { fraction: range > 0 ? list.scrollTop / range : 1 });
  }, 150);
}, true);

function postObsStyle() {
  postJson("/api/obs-style", {
    fontSize: Number(obsStyleAdmin.querySelector('[data-style="fontSize"]')?.value),
    borderWidth: Number(obsStyleAdmin.querySelector('[data-style="borderWidth"]')?.value),
    textColor: obsStyleAdmin.querySelector('[data-style="textColor"]')?.dataset.color,
    accentColor: obsStyleAdmin.querySelector('[data-style="accentColor"]')?.dataset.color,
    background: obsStyleAdmin.querySelector('[data-style="background"]')?.value,
    showChat: Boolean(obsStyleAdmin.querySelector('[data-style="showChat"]')?.checked),
    chatHeader: Boolean(obsStyleAdmin.querySelector('[data-style="chatHeader"]')?.checked),
  });
}

obsStyleAdmin?.addEventListener("input", () => postObsStyle());

obsStyleAdmin?.addEventListener("click", (event) => {
  const swatch = event.target.closest(".color-swatch");
  if (!swatch) return;
  const key = swatch.dataset.style;
  openColorPopover(swatch, swatch.dataset.color || "", {
    onPick: (hex) => {
      swatch.dataset.color = hex;
      swatch.style.background = hex;
      postObsStyle();
    },
    onReset: () => {
      const fallback = OBS_STYLE_DEFAULTS[key];
      swatch.dataset.color = fallback;
      swatch.style.background = fallback;
      postObsStyle();
    },
  });
});

userInfoPanel?.addEventListener("click", (event) => {
  if (event.target.closest(".user-card-logs")) {
    const message = selectedMessage();
    if (message) openUserLogs(message);
    return;
  }
  if (event.target.closest(".user-card-spotlight")) {
    const target = userLogs || selectedMessage();
    if (!target) return;
    if (isSpotlighted(target)) {
      postJson("/api/spotlight/stop");
    } else {
      postJson("/api/spotlight", { sourceId: target.sourceId, author: target.author });
    }
    return;
  }
  if (event.target.closest(".user-card-back")) {
    userLogs = null;
    renderUserInfoPanel();
    return;
  }
  if (!event.target.closest(".user-card-close")) return;
  userLogs = null;
  selectedMessageKey = "";
  renderUserInfoPanel();
  feed.querySelector(".message.selected")?.classList.remove("selected");
});

resumeScrollButton?.addEventListener("click", jumpToLive);

loadInputs();
if (!sources.length) {
  sources = platforms.filter((platform) => !platform.disabled).map((platform) => createSource(platform.id));
}
loadSettings();
loadSectionPrefs();
applySectionPrefs();
connectEventStream();
renderSources();
renderStatuses();
renderFeed();
renderPollAdmin();
scheduleAutoConnect(200);
