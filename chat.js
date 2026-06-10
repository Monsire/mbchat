const SETTINGS_KEY = "chatbubble.settings.v1";

// ?embed=1 (the public watch page) renders a read-only feed: no user cards,
// no message selection, no logs.
const IS_EMBED = new URLSearchParams(window.location.search).has("embed");
if (IS_EMBED) document.body.classList.add("embed");

const platformLabels = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
  x: "X",
};

const platformIcons = {
  twitch: "./assets/twitch-logo.png",
  youtube: "./assets/youtube-logo.webp",
  kick: "./assets/kick-logo.avif",
  x: "./assets/x-logo.jpg",
};

const feed = document.querySelector("#feed");
const resumeScrollButton = document.querySelector("#resume-scroll");
const userInfoPanel = document.querySelector("#user-info-panel");
const pollWidget = document.querySelector("#poll-widget");

let eventSource = null;
let messages = [];
let sources = [];
let poll = null;
let statuses = {
  twitch: "idle",
  youtube: "idle",
  kick: "idle",
  x: "idle",
};
let settings = {};
let isPinnedToLive = true;
let isRestoringScroll = false;
let selectedMessageKey = "";

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
  const label = platformLabels[platform] || platform;
  const sourceLabelText = String(source?.label || "").trim();
  return `
    <span class="message-source ${escapeHtml(platform)}" title="${escapeHtml(label)}">
      <img class="message-platform-icon" src="${escapeHtml(icon)}" alt="${escapeHtml(label)}" loading="lazy" />
      ${sourceLabelText ? `<span class="message-source-label">${escapeHtml(sourceLabelText)}</span>` : ""}
    </span>
  `;
}

function platformLabel(platform) {
  return platformLabels[platform] || platform;
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

function loadSettings() {
  try {
    settings = { ...settings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch {
    localStorage.removeItem(SETTINGS_KEY);
  }
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
    </div>
  `;

  const list = userInfoPanel.querySelector(".user-log-list");
  if (list) list.scrollTop = wasNearBottom ? list.scrollHeight : previousScrollTop;
}

function renderUserInfoPanel() {
  if (!userInfoPanel) return;

  if (userLogs) {
    const signature = `logs:${userLogs.author}:${userLogs.sourceId}:${userLogs.loading}:${userLogs.messages.length}`;
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

function markPlatformLive(platform) {
  if (platform && statuses[platform] !== "connected") {
    statuses[platform] = "connected";
  }
}

function connectEventStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("ready", (event) => {
    const data = JSON.parse(event.data);
    if (Array.isArray(data.statuses)) {
      data.statuses.forEach((status) => {
        if (status?.platform) statuses[status.platform] = status.status;
      });
    } else {
      statuses = { ...statuses, ...(data.statuses || {}) };
    }
    sources = Array.isArray(data.sources) ? data.sources : [];
    messages = data.recentMessages || [];
    poll = data.poll || null;
    window.PollWidget.render(pollWidget, poll);
    renderFeed();
  });

  eventSource.addEventListener("reset", () => {
    messages = [];
    sources = [];
    statuses = { twitch: "idle", youtube: "idle", kick: "idle", x: "idle" };
    poll = null;
    window.PollWidget.render(pollWidget, poll);
    renderFeed();
  });

  eventSource.addEventListener("poll", (event) => {
    poll = JSON.parse(event.data);
    window.PollWidget.render(pollWidget, poll);
  });

  eventSource.addEventListener("source-reset", (event) => {
    const data = JSON.parse(event.data);
    messages = messages.filter((message) => message.sourceId !== data.sourceId);
    renderFeed();
  });

  eventSource.addEventListener("sources", (event) => {
    sources = JSON.parse(event.data) || [];
    renderFeed();
  });

  eventSource.addEventListener("status", (event) => {
    const data = JSON.parse(event.data);
    statuses[data.platform] = data.status;
  });

  eventSource.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    markPlatformLive(message.platform);
    messages = [message, ...messages].slice(0, 100);
    appendToOpenUserLogs(message);
    renderFeed();
  });
}

window.addEventListener("storage", (event) => {
  if (event.key !== SETTINGS_KEY) return;
  loadSettings();
  renderFeed();
});

feed.addEventListener("scroll", () => {
  if (isRestoringScroll) return;
  setPinnedToLive(isAtLiveEdge());
}, { passive: true });

feed.addEventListener("click", (event) => {
  if (IS_EMBED) return;
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
  if (IS_EMBED) return;
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

userInfoPanel?.addEventListener("click", (event) => {
  if (event.target.closest(".user-card-logs")) {
    const message = selectedMessage();
    if (message) openUserLogs(message);
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

loadSettings();
connectEventStream();
renderFeed();
