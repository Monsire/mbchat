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
const chatPanel = document.querySelector("#obs-chat-panel");
const chatBar = document.querySelector("#obs-chat-bar");
const pollWidget = document.querySelector("#poll-widget");
const spotlightPanel = document.querySelector("#spotlight-panel");

let eventSource = null;
let messages = [];
let sources = [];
let poll = null;
let spotlight = null;
let spotlightScrollFraction = 1;

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

const eventTags = {
  bits: "Bits",
  superchat: "Super Chat",
  sub: "Sub",
  giftsub: "Gift Sub",
  membership: "Member",
};

function renderEventMessage(message) {
  const hasText = Boolean(String(message.text || "").trim());
  return `
    <article class="message event ${escapeHtml(message.platform)}">
      ${renderMessageSource(message)}
      <span class="event-tag">${escapeHtml(eventTags[message.event?.type] || "Event")}</span>
      <span class="message-author" style="${authorStyle(message)}">${escapeHtml(message.author)}</span>
      <span class="event-label">${escapeHtml(message.event?.label || "")}</span>
      ${hasText ? `<span class="message-text event-text">${renderMessageParts(message)}</span>` : ""}
    </article>
  `;
}

function renderFeed() {
  if (!messages.length) {
    feed.innerHTML = "";
    return;
  }

  feed.innerHTML = messages
    .slice(0, 60)
    .map((message) => {
      if (message.kind === "event") return renderEventMessage(message);
      return `
      <article class="message ${escapeHtml(message.platform)}">
        ${renderMessageSource(message)}
        <span class="message-author" style="${authorStyle(message)}">${escapeHtml(message.author)}</span><span class="message-separator">:</span>
        <span class="message-text">${renderMessageParts(message)}</span>
      </article>
    `;
    })
    .join("");

  feed.scrollTop = 0;
}

function formatMessageTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderPoll() {
  window.PollWidget.render(pollWidget, poll);
}

function renderSpotlight() {
  if (!spotlight) {
    spotlightPanel.hidden = true;
    spotlightPanel.innerHTML = "";
    return;
  }

  const icon = platformIcons[spotlight.platform] || "";
  if (Number.isFinite(Number(spotlight.scrollFraction))) {
    spotlightScrollFraction = Number(spotlight.scrollFraction);
  }
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

  spotlightPanel.hidden = false;
  spotlightPanel.innerHTML = `
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
  `;
  applySpotlightScroll(false);
}

function applySpotlightScroll(smooth = true) {
  const list = spotlightPanel.querySelector(".obs-spotlight-messages");
  if (!list) return;
  const range = list.scrollHeight - list.clientHeight;
  const top = range > 0 ? range * Math.max(0, Math.min(1, spotlightScrollFraction)) : 0;
  if (smooth) {
    list.scrollTo({ top, behavior: "smooth" });
  } else {
    list.scrollTop = top;
  }
}

function applyObsStyle(style) {
  if (!style) return;
  const root = document.documentElement;
  root.style.setProperty("--obs-font-size", `${Number(style.fontSize) || 14}px`);
  root.style.setProperty("--obs-border", `${Number(style.borderWidth) || 2}px`);
  if (safeColor(style.textColor)) root.style.setProperty("--ink", style.textColor);
  if (safeColor(style.accentColor)) root.style.setProperty("--accent", style.accentColor);
  document.body.classList.toggle("transparent", style.background === "transparent");
  chatPanel.hidden = style.showChat === false;
  chatBar.hidden = style.chatHeader === false;
}

function connectEventStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("ready", (event) => {
    const data = JSON.parse(event.data);
    sources = Array.isArray(data.sources) ? data.sources : [];
    messages = data.recentMessages || [];
    poll = data.poll || null;
    spotlight = data.spotlight || null;
    applyObsStyle(data.obsStyle);
    renderFeed();
    renderPoll();
    renderSpotlight();
  });

  eventSource.addEventListener("reset", () => {
    messages = [];
    sources = [];
    poll = null;
    spotlight = null;
    renderFeed();
    renderPoll();
    renderSpotlight();
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

  eventSource.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    messages = [message, ...messages].slice(0, 100);
    renderFeed();
  });

  eventSource.addEventListener("poll", (event) => {
    poll = JSON.parse(event.data);
    renderPoll();
  });

  eventSource.addEventListener("spotlight", (event) => {
    spotlight = JSON.parse(event.data);
    renderSpotlight();
  });

  eventSource.addEventListener("spotlight-scroll", (event) => {
    const data = JSON.parse(event.data);
    if (Number.isFinite(Number(data.fraction))) {
      spotlightScrollFraction = Number(data.fraction);
      applySpotlightScroll();
    }
  });

  eventSource.addEventListener("obs-style", (event) => {
    applyObsStyle(JSON.parse(event.data));
  });
}

connectEventStream();
renderFeed();
