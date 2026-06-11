const platformNames = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
  x: "X",
};

// The watch page channel; the connected sources only feed the chat.
const WATCH_CHANNEL = "fazebanks";

const tickerItems = document.querySelector("#ticker-items");
const twitchPlayer = document.querySelector("#twitch-player");

let eventSource = null;
let sources = [];
let viewers = {};
let playerSet = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function syncPlayer() {
  if (playerSet) return;
  playerSet = true;

  let info = { live: true, videoId: "" };
  try {
    info = await fetch(`/api/watch-stream?channel=${WATCH_CHANNEL}`).then((response) => response.json());
  } catch {
    // Fall back to the live player; Twitch's embed plays the latest broadcast itself.
  }

  const params = new URLSearchParams({
    parent: window.location.hostname,
    autoplay: "true",
    muted: "true",
  });
  if (!info.live && info.videoId) {
    params.set("video", info.videoId);
  } else {
    params.set("channel", WATCH_CHANNEL);
  }
  twitchPlayer.src = `https://player.twitch.tv/?${params}`;
}

function formatViewers(count) {
  return Number(count).toLocaleString("en-US");
}

function renderTicker() {
  if (!tickerItems) return;

  const parts = sources
    .map((source) => {
      const count = viewers[source.id];
      if (!Number.isFinite(count)) return "";
      const name = platformNames[source.platform] || source.platform;
      return `<span class="watch-count"><em>${escapeHtml(name)}</em>${formatViewers(count)}</span>`;
    })
    .filter(Boolean);

  const counts = Object.values(viewers).filter((value) => Number.isFinite(value));
  const total = counts.reduce((sum, value) => sum + value, 0);

  tickerItems.innerHTML = counts.length
    ? `<span class="watch-count total"><em>Watching</em>${formatViewers(total)}</span>${parts.join("")}`
    : "";
}

// Long-lived SSE streams get a dedicated port so they don't exhaust the
// browser's 6-connections-per-origin budget and stall page loads.
let eventStreamOpened = false;
let useSameOriginEvents = false;

function eventStreamUrl() {
  const { protocol, hostname, port } = window.location;
  if (useSameOriginEvents || !protocol.startsWith("http") || !port) return "/api/events";
  return `${protocol}//${hostname}:${Number(port) + 1}/api/events`;
}

function connectEventStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(eventStreamUrl());
  eventSource.onopen = () => {
    eventStreamOpened = true;
  };
  eventSource.onerror = () => {
    if (!eventStreamOpened && !useSameOriginEvents) {
      useSameOriginEvents = true;
      connectEventStream();
    }
  };

  eventSource.addEventListener("ready", (event) => {
    const data = JSON.parse(event.data);
    sources = Array.isArray(data.sources) ? data.sources : [];
    viewers = data.viewers || {};
    renderTicker();
  });

  eventSource.addEventListener("sources", (event) => {
    sources = JSON.parse(event.data) || [];
    renderTicker();
  });

  eventSource.addEventListener("viewers", (event) => {
    const data = JSON.parse(event.data);
    if (!data.sourceId) return;
    if (data.count === null || !Number.isFinite(Number(data.count))) {
      delete viewers[data.sourceId];
    } else {
      viewers[data.sourceId] = Number(data.count);
    }
    renderTicker();
  });

  eventSource.addEventListener("reset", () => {
    sources = [];
    viewers = {};
    renderTicker();
  });
}

syncPlayer();
connectEventStream();
