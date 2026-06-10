import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Events as KickEvents, KickConnection } from "kick-live-connector";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
// Public web bearer x.com ships to logged-out browsers. Not a secret; rotates rarely.
const X_WEB_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const X_GUEST_TOKEN_TTL = 2 * 60 * 60 * 1000;
// GraphQL query IDs from the public x.com web bundle. X rotates these occasionally;
// if handle resolution starts failing, refresh them (the broadcast URL/ID path is
// unaffected). The feature flags just need to be present and truthy.
const X_GRAPHQL_USER_BY_SCREEN_NAME = "sLVLhk0bGj3MVFEKTdax1w";
const X_GRAPHQL_USER_TWEETS = "E3opETHurmVJflFsUBVuUQ";
let xGuestToken = "";
let xGuestTokenAt = 0;
const xUserIdCache = new Map();

const clients = new Set();
const connectors = new Map();
const activeSources = new Map();
const sourceStatuses = new Map();
let recentMessages = [];
let bttvGlobalEmotes = null;
let ffzGlobalEmotes = null;
let sevenTvGlobalEmotes = null;
const seenMessageKeys = new Map();
const MESSAGE_DEDUPE_TTL = 2 * 60 * 1000;
const LIVE_BACKFILL_WINDOW_MS = 5_000;

process.on("unhandledRejection", (error) => {
  console.error("[unhandled]", error?.message || error);
});

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    sendSSE(res, event, data);
  }
}

function emitStatus(platform, status, detail = "", sourceId = platform) {
  const payload = { sourceId, platform, status, detail, at: Date.now() };
  sourceStatuses.set(sourceId, payload);
  if (status === "error") {
    console.error(`[${platform}:${sourceId}] ${detail}`);
  }
  broadcast("status", payload);
}

const MESSAGE_LOG_LIMIT = 5000;
const messageLogs = new Map();

const viewerCounts = new Map();

function emitViewers(sourceId, count) {
  const value = Number.isFinite(Number(count)) ? Number(count) : null;
  viewerCounts.set(sourceId, value);
  broadcast("viewers", { sourceId, count: value });
}

function appendToMessageLog(message) {
  const log = messageLogs.get(message.sourceId) || [];
  log.push(message);
  if (log.length > MESSAGE_LOG_LIMIT) log.splice(0, log.length - MESSAGE_LOG_LIMIT);
  messageLogs.set(message.sourceId, log);
}

function userMessageLog(sourceId, author) {
  const target = String(author || "").toLowerCase();
  if (!target) return [];
  const logs = sourceId
    ? [messageLogs.get(sourceId) || []]
    : Array.from(messageLogs.values());
  return logs
    .flat()
    .filter((message) => String(message.author || "").toLowerCase() === target)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 500);
}

const POLL_OPTION_LIMIT = 6;
let activePoll = null;
let pollEndTimer = null;

const SPOTLIGHT_MESSAGE_LIMIT = 50;
let activeSpotlight = null;

const OBS_STYLE_DEFAULTS = {
  fontSize: 18,
  borderWidth: 2,
  textColor: "#f2f2f2",
  accentColor: "#f2f2f2",
  background: "dark",
  showChat: true,
  chatHeader: true,
};
let obsStyle = { ...OBS_STYLE_DEFAULTS };

function publicPoll() {
  if (!activePoll) return null;
  const { voters, ...poll } = activePoll;
  return { ...poll, totalVotes: voters.size };
}

function broadcastPoll() {
  broadcast("poll", publicPoll());
}

function startPoll({ question, options, duration, displayMode } = {}) {
  const cleanQuestion = cleanInput(question).slice(0, 140);
  const cleanOptions = (Array.isArray(options) ? options : [])
    .map((option) => cleanInput(option).slice(0, 60))
    .filter(Boolean)
    .slice(0, POLL_OPTION_LIMIT);
  if (cleanOptions.length < 2) throw new Error("a poll needs at least 2 options");

  const durationSeconds = Math.min(Math.max(Number(duration) || 60, 10), 3600);
  clearTimeout(pollEndTimer);
  activePoll = {
    id: `poll_${Date.now().toString(36)}`,
    question: cleanQuestion,
    options: cleanOptions.map((label) => ({ label, votes: 0 })),
    voters: new Map(),
    startedAt: Date.now(),
    endsAt: Date.now() + durationSeconds * 1000,
    status: "active",
    displayMode: displayMode === "pie" ? "pie" : "bars",
  };
  pollEndTimer = setTimeout(endPoll, durationSeconds * 1000);
  broadcastPoll();
}

function endPoll() {
  if (!activePoll || activePoll.status !== "active") return;
  clearTimeout(pollEndTimer);
  activePoll.status = "ended";
  activePoll.endsAt = Date.now();
  broadcastPoll();
}

function clearPoll() {
  clearTimeout(pollEndTimer);
  activePoll = null;
  broadcastPoll();
}

function setPollDisplayMode(mode) {
  if (!activePoll) return;
  activePoll.displayMode = mode === "pie" ? "pie" : "bars";
  broadcastPoll();
}

// A message votes if it contains the option number or the option text anywhere
// (case-insensitive, word-bounded). Messages matching several options are
// ambiguous and ignored.
function pollOptionMatches(text, option, index) {
  if (new RegExp(`(^|\\W)${index + 1}(\\W|$)`).test(text)) return true;
  const label = String(option.label || "").toLowerCase();
  if (!label) return false;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(text);
}

function registerPollVote(message) {
  if (!activePoll || activePoll.status !== "active" || message.kind !== "chat") return;
  const text = String(message.text || "").trim().toLowerCase();
  if (!text) return;

  const matches = activePoll.options
    .map((option, index) => (pollOptionMatches(text, option, index) ? index : -1))
    .filter((index) => index !== -1);
  if (matches.length !== 1) return;
  const optionIndex = matches[0];

  const voterKey = `${message.platform}:${String(message.author || "").toLowerCase()}`;
  if (activePoll.voters.has(voterKey)) return;
  activePoll.voters.set(voterKey, optionIndex);
  activePoll.options[optionIndex].votes += 1;
  broadcastPoll();
}

function startSpotlight(sourceId, author) {
  if (!cleanInput(author)) throw new Error("missing spotlight user");
  const log = userMessageLog(sourceId, author);
  const latest = log[0] || null;
  activeSpotlight = {
    sourceId: sourceId || latest?.sourceId || "",
    author: latest?.author || cleanInput(author),
    authorUrl: latest?.authorUrl || "",
    avatar: latest?.avatar || "",
    platform: latest?.platform || activeSources.get(sourceId)?.platform || "",
    startedAt: Date.now(),
    scrollFraction: 1,
    messages: log.slice(0, SPOTLIGHT_MESSAGE_LIMIT),
  };
  broadcast("spotlight", activeSpotlight);

  if (!activeSpotlight.avatar) {
    const current = activeSpotlight;
    const login = current.authorUrl.split("/").filter(Boolean).pop() || current.author;
    resolveAvatar(current.platform, login).then((avatar) => {
      if (avatar && activeSpotlight === current) {
        activeSpotlight.avatar = avatar;
        broadcast("spotlight", activeSpotlight);
      }
    });
  }
}

function stopSpotlight() {
  activeSpotlight = null;
  broadcast("spotlight", null);
}

function appendToSpotlight(message) {
  if (!activeSpotlight) return;
  if (activeSpotlight.sourceId && message.sourceId !== activeSpotlight.sourceId) return;
  if (String(message.author || "").toLowerCase() !== activeSpotlight.author.toLowerCase()) return;
  if (!activeSpotlight.avatar && message.avatar) activeSpotlight.avatar = message.avatar;
  activeSpotlight.messages = [message, ...activeSpotlight.messages].slice(0, SPOTLIGHT_MESSAGE_LIMIT);
  broadcast("spotlight", activeSpotlight);
}

function applyObsStyle(patch = {}) {
  const next = { ...obsStyle };
  const fontSize = Number(patch.fontSize);
  if (Number.isFinite(fontSize)) next.fontSize = Math.min(Math.max(Math.round(fontSize), 10), 48);
  const borderWidth = Number(patch.borderWidth);
  if (Number.isFinite(borderWidth)) next.borderWidth = Math.min(Math.max(Math.round(borderWidth), 1), 10);
  if (/^#[0-9a-f]{3,8}$/i.test(String(patch.textColor || ""))) next.textColor = patch.textColor;
  if (/^#[0-9a-f]{3,8}$/i.test(String(patch.accentColor || ""))) next.accentColor = patch.accentColor;
  if (["dark", "transparent"].includes(patch.background)) next.background = patch.background;
  if (typeof patch.showChat === "boolean") next.showChat = patch.showChat;
  if (typeof patch.chatHeader === "boolean") next.chatHeader = patch.chatHeader;
  obsStyle = next;
  broadcast("obs-style", obsStyle);
}

function emitMessage(message) {
  const sourceId = message.sourceId || message.platform;
  const normalized = {
    id: message.id || `${sourceId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    sourceId,
    platform: message.platform,
    author: message.author || "unknown",
    text: message.text || "",
    parts: message.parts || [{ type: "text", text: message.text || "" }],
    color: message.color || "",
    avatar: message.avatar || "",
    authorUrl: message.authorUrl || "",
    badges: message.badges || [],
    createdAt: message.createdAt || Date.now(),
    kind: message.kind || "chat",
    event: message.event || null,
    raw: message.raw || null,
  };

  const key = messageDedupeKey(normalized);
  if (hasRecentlySeenMessage(key)) return;
  rememberMessageKey(key);

  recentMessages = [normalized, ...recentMessages].slice(0, 100);
  appendToMessageLog(normalized);
  registerPollVote(normalized);
  broadcast("message", normalized);
  appendToSpotlight(normalized);
}

function messageDedupeKey(message) {
  const sourceId = message.sourceId || message.platform;
  if (message.id) return `${sourceId}:id:${message.id}`;
  const bucket = Math.floor(Number(message.createdAt || Date.now()) / 2000);
  return `${sourceId}:body:${message.author}:${message.text}:${bucket}`;
}

function pruneSeenMessageKeys() {
  const cutoff = Date.now() - MESSAGE_DEDUPE_TTL;
  for (const [key, timestamp] of seenMessageKeys) {
    if (timestamp < cutoff) seenMessageKeys.delete(key);
  }
}

function hasRecentlySeenMessage(key) {
  pruneSeenMessageKeys();
  return seenMessageKeys.has(key);
}

function rememberMessageKey(key) {
  seenMessageKeys.set(key, Date.now());
  if (seenMessageKeys.size > 1000) {
    const oldestKey = seenMessageKeys.keys().next().value;
    if (oldestKey) seenMessageKeys.delete(oldestKey);
  }
}

function pruneSourceMessageKeys(sourceId) {
  const prefix = `${sourceId}:`;
  for (const key of seenMessageKeys.keys()) {
    if (key.startsWith(prefix)) seenMessageKeys.delete(key);
  }
}

function resetSourceMessages(sourceId) {
  recentMessages = recentMessages.filter((message) => message.sourceId !== sourceId);
  messageLogs.delete(sourceId);
  pruneSourceMessageKeys(sourceId);
  broadcast("source-reset", { sourceId });
}

function cleanInput(input = "") {
  return String(input).trim();
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function parseMaybeUrl(value) {
  const input = cleanInput(value);
  if (!input) return null;
  try {
    return new URL(input);
  } catch {
    try {
      return new URL(`https://${input}`);
    } catch {
      return null;
    }
  }
}

function pathParts(url) {
  return url.pathname.split("/").filter(Boolean);
}

function cleanHandle(value = "") {
  return cleanInput(value)
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .trim();
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, "");
}

function decodeEntities(value = "") {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#039;", "'");
}

function browserHeaders(extra = {}) {
  return {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    ...extra,
  };
}

function extractBalancedJson(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = source.indexOf("{", markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function getByPath(obj, keys) {
  let current = obj;
  for (const key of keys) {
    current = current?.[key];
    if (current === undefined || current === null) return undefined;
  }
  return current;
}

function findFirstByKey(obj, wantedKey) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, wantedKey)) return obj[wantedKey];
  for (const value of Object.values(obj)) {
    const found = findFirstByKey(value, wantedKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

function runsToText(runs = {}) {
  return (runs.runs || [])
    .map((run) => {
      if (run.text) return run.text;
      if (run.emoji?.shortcuts?.length) return run.emoji.shortcuts[0];
      return run.emoji?.emojiId || "";
    })
    .join("");
}

function bestThumbnail(thumbnails = {}) {
  const list = thumbnails.thumbnails || [];
  return list.length ? list[list.length - 1].url : "";
}

function runsToParts(runs = {}) {
  const parts = [];
  for (const run of runs.runs || []) {
    if (run.text) {
      parts.push({ type: "text", text: run.text });
      continue;
    }
    if (!run.emoji) continue;
    const name = run.emoji.shortcuts?.[0] || run.emoji.emojiId || "emote";
    const url = run.emoji.isCustomEmoji ? bestThumbnail(run.emoji.image) : "";
    if (url) {
      parts.push({ type: "emote", name, url });
    } else {
      parts.push({ type: "text", text: run.emoji.emojiId || name });
    }
  }
  return parts;
}

function buildKickParts(content) {
  const source = String(content || "");
  const parts = [];
  const emotePattern = /\[emote:(\d+):([^\]]*)\]/g;
  let cursor = 0;
  let match;

  while ((match = emotePattern.exec(source)) !== null) {
    if (match.index > cursor) {
      const text = decodeEntities(stripHtml(source.slice(cursor, match.index)));
      if (text) parts.push({ type: "text", text });
    }
    parts.push({
      type: "emote",
      name: match[2] || "emote",
      url: `https://files.kick.com/emotes/${match[1]}/fullsize`,
    });
    cursor = emotePattern.lastIndex;
  }

  if (cursor < source.length) {
    const text = decodeEntities(stripHtml(source.slice(cursor)));
    if (text) parts.push({ type: "text", text });
  }

  return parts;
}

// Badges without real image art are dropped entirely — no placeholders.
function parseBadges(authorBadges = []) {
  return authorBadges
    .map((badge) => {
      const renderer = badge.liveChatAuthorBadgeRenderer;
      if (!renderer) return null;
      const url = bestThumbnail(renderer.customThumbnail || {});
      if (!url) return null;
      return { label: renderer.tooltip || "badge", url };
    })
    .filter(Boolean);
}

function kickBadges(identity) {
  return (identity?.badges_v2 || [])
    .filter((badge) => badge?.image_url)
    .map((badge) => ({
      label: badge.metadata?.level ? `${badge.name} ${badge.metadata.level}` : (badge.name || "badge"),
      url: badge.image_url,
    }));
}

let twitchGlobalBadges = null;

async function twitchGql(query) {
  const response = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "client-id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`Twitch GQL returned ${response.status}`);
  return response.json();
}

function twitchBadgeEntries(badges) {
  return (badges || [])
    .filter((badge) => badge?.setID && badge?.imageURL)
    .map((badge) => [`${badge.setID}/${badge.version ?? "1"}`, badge.imageURL]);
}

async function fetchTwitchGlobalBadges() {
  if (twitchGlobalBadges) return twitchGlobalBadges;
  try {
    const data = await twitchGql("{ badges { setID version imageURL(size: DOUBLE) } }");
    twitchGlobalBadges = new Map(twitchBadgeEntries(data?.data?.badges));
  } catch {
    twitchGlobalBadges = new Map();
  }
  return twitchGlobalBadges;
}

async function fetchTwitchChannelBadges(login) {
  try {
    const data = await twitchGql(`{ user(login: ${JSON.stringify(login)}) { broadcastBadges { setID version imageURL(size: DOUBLE) } } }`);
    return new Map(twitchBadgeEntries(data?.data?.user?.broadcastBadges));
  } catch {
    return new Map();
  }
}

const avatarCache = new Map();

// Twitch blanks VOD lists for this long-running process (anti-scraper gating)
// even on fresh connections, while one-off processes get real answers every
// time — so this lookup runs in a short-lived child process.
function twitchGqlChild(query) {
  const script = `
    fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "content-type": "application/json", "client-id": "kimne78kx3ncx6brgo4mv6wki5h1ko" },
      body: process.argv[1],
    })
      .then((response) => response.json())
      .then((data) => console.log(JSON.stringify(data)))
      .catch(() => process.exit(1));
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", script, JSON.stringify({ query })], { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

const watchStreamCache = new Map();

// Twitch answers this query inconsistently (some responses blank the VOD list),
// so retry a few times and only cache answers that are actually usable.
async function resolveWatchStream(channel) {
  const cached = watchStreamCache.get(channel);
  if (cached && Date.now() - cached.at < 60_000) return cached.result;

  let result = { live: true, videoId: "" };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const data = await twitchGqlChild(`{ user(login: ${JSON.stringify(channel)}) { stream { id } videos(first: 1, types: [ARCHIVE], sort: TIME) { edges { node { id } } } } }`);
      const user = data?.data?.user;
      result = {
        live: Boolean(user?.stream?.id),
        videoId: user?.videos?.edges?.[0]?.node?.id || "",
      };
      if (result.live || result.videoId) {
        watchStreamCache.set(channel, { at: Date.now(), result });
        return result;
      }
    } catch {
      result = { live: true, videoId: "" };
    }
  }
  return result;
}

async function fetchTwitchAvatar(login) {
  const data = await twitchGql(`{ user(login: ${JSON.stringify(login)}) { profileImageURL(width: 70) } }`);
  return data?.data?.user?.profileImageURL || "";
}

// Kick's API sits behind bot protection that rejects plain fetch, but passes a
// real Chromium page with this legacy UA (the same one kick-live-connector uses).
// One shared page handles all lookups, serialized through a queue.
const KICK_LOOKUP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3";
let kickPagePromise = null;
let kickLookupQueue = Promise.resolve();

function getKickLookupPage() {
  if (!kickPagePromise) {
    kickPagePromise = (async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      return browser.newPage({ userAgent: KICK_LOOKUP_UA });
    })().catch((error) => {
      kickPagePromise = null;
      throw error;
    });
  }
  return kickPagePromise;
}

function kickApiFetch(url) {
  const job = async () => {
    try {
      const page = await getKickLookupPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      return JSON.parse(await page.evaluate(() => document.body.innerText));
    } catch (error) {
      if (/closed|crashed|Target/i.test(String(error.message))) kickPagePromise = null;
      throw error;
    }
  };
  const run = kickLookupQueue.then(job, job);
  kickLookupQueue = run.catch(() => {});
  return run;
}

async function fetchKickAvatar(value) {
  const fromUsers = await kickApiFetch(`https://kick.com/api/v1/users/${encodeURIComponent(value)}`)
    .then((data) => data?.profilepic || data?.profile_pic || "")
    .catch(() => "");
  if (fromUsers) return fromUsers;
  // Chat gives us the slug; the slug-keyed channel endpoint covers users whose
  // username differs from their slug (underscores become dashes).
  return kickApiFetch(`https://kick.com/api/v2/channels/${encodeURIComponent(value)}`)
    .then((data) => data?.user?.profile_pic || "")
    .catch(() => "");
}

// YouTube and X already ship avatars with each chat message. Kick's URLs are
// signed S3 links that expire after ~20 minutes, so those re-resolve on a TTL.
function resolveAvatar(platform, value) {
  const cleaned = cleanInput(value).toLowerCase();
  if (!cleaned || !["twitch", "kick"].includes(platform)) return Promise.resolve("");
  const key = `${platform}:${cleaned}`;
  const ttl = platform === "kick" ? 15 * 60 * 1000 : Infinity;
  const cached = avatarCache.get(key);
  if (cached && Date.now() - cached.at < (cached.empty ? 60_000 : ttl)) return cached.promise;
  const entry = { at: Date.now(), empty: false, promise: null };
  entry.promise = (platform === "twitch" ? fetchTwitchAvatar(cleaned) : fetchKickAvatar(cleaned))
    .catch(() => "")
    .then((avatar) => {
      if (!avatar) entry.empty = true;
      return avatar;
    });
  avatarCache.set(key, entry);
  if (avatarCache.size > 3000) avatarCache.delete(avatarCache.keys().next().value);
  return entry.promise;
}

function parseTwitchBadges(tag, badgeMap) {
  return String(tag || "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [set, version = "1"] = entry.split("/");
      const url = badgeMap?.get(`${set}/${version}`) || badgeMap?.get(`${set}/1`) || "";
      return url ? { label: set.replaceAll("-", " ").replaceAll("_", " "), url } : null;
    })
    .filter(Boolean);
}

function parseTwitchEmoteTag(emoteTag = "") {
  const ranges = [];
  if (!emoteTag) return ranges;

  emoteTag.split("/").forEach((entry) => {
    const [id, positions = ""] = entry.split(":");
    positions.split(",").forEach((position) => {
      const [start, end] = position.split("-").map(Number);
      if (id && Number.isInteger(start) && Number.isInteger(end)) {
        ranges.push({
          start,
          end,
          type: "emote",
          name: "",
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`,
        });
      }
    });
  });

  return ranges.sort((a, b) => a.start - b.start);
}

function splitTextWithBttv(text, bttvEmotes) {
  if (!text || !bttvEmotes?.size) return text ? [{ type: "text", text }] : [];

  const parts = [];
  const tokens = text.match(/(\s+|\S+)/g) || [];

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      parts.push({ type: "text", text: token });
      continue;
    }

    const emote = bttvEmotes.get(token);
    if (emote) {
      parts.push({
        type: "emote",
        name: emote.code,
        url: emote.url,
      });
    } else {
      parts.push({ type: "text", text: token });
    }
  }

  return parts;
}

function buildTwitchParts(text, emoteTag, bttvEmotes) {
  const nativeRanges = parseTwitchEmoteTag(emoteTag);
  if (!nativeRanges.length) return splitTextWithBttv(text, bttvEmotes);

  const parts = [];
  let cursor = 0;

  for (const range of nativeRanges) {
    if (range.start > cursor) {
      parts.push(...splitTextWithBttv(text.slice(cursor, range.start), bttvEmotes));
    }

    parts.push({
      ...range,
      name: text.slice(range.start, range.end + 1),
    });
    cursor = range.end + 1;
  }

  if (cursor < text.length) {
    parts.push(...splitTextWithBttv(text.slice(cursor), bttvEmotes));
  }

  return parts;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function bttvEmoteEntry(emote) {
  return [emote.code, { code: emote.code, url: `https://cdn.betterttv.net/emote/${emote.id}/2x` }];
}

async function fetchBttvGlobalEmotes() {
  if (bttvGlobalEmotes) return bttvGlobalEmotes;
  try {
    const emotes = await fetchJson("https://api.betterttv.net/3/cached/emotes/global");
    bttvGlobalEmotes = new Map(emotes.map(bttvEmoteEntry));
  } catch {
    bttvGlobalEmotes = new Map();
  }
  return bttvGlobalEmotes;
}

function ffzSetEntries(data) {
  return Object.values(data?.sets || {})
    .flatMap((set) => set.emoticons || [])
    .map((emote) => {
      let url = emote.urls?.["2"] || emote.urls?.["1"] || "";
      if (url.startsWith("//")) url = `https:${url}`;
      return url ? [emote.name, { code: emote.name, url }] : null;
    })
    .filter(Boolean);
}

async function fetchFfzGlobalEmotes() {
  if (ffzGlobalEmotes) return ffzGlobalEmotes;
  try {
    const data = await fetchJson("https://api.frankerfacez.com/v1/set/global");
    ffzGlobalEmotes = new Map(ffzSetEntries(data));
  } catch {
    ffzGlobalEmotes = new Map();
  }
  return ffzGlobalEmotes;
}

async function fetchFfzChannelEmotes(login) {
  try {
    const data = await fetchJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login)}`);
    return new Map(ffzSetEntries(data));
  } catch {
    return new Map();
  }
}

function sevenTvEmoteEntries(emotes) {
  return (emotes || [])
    .filter((emote) => emote?.name && emote?.id)
    .map((emote) => [emote.name, { code: emote.name, url: `https://cdn.7tv.app/emote/${emote.id}/2x.webp` }]);
}

async function fetchSevenTvGlobalEmotes() {
  if (sevenTvGlobalEmotes) return sevenTvGlobalEmotes;
  try {
    const data = await fetchJson("https://7tv.io/v3/emote-sets/global");
    sevenTvGlobalEmotes = new Map(sevenTvEmoteEntries(data.emotes));
  } catch {
    sevenTvGlobalEmotes = new Map();
  }
  return sevenTvGlobalEmotes;
}

async function fetchSevenTvChannelEmotes(userId) {
  if (!userId) return new Map();
  try {
    const data = await fetchJson(`https://7tv.io/v3/users/twitch/${userId}`);
    return new Map(sevenTvEmoteEntries(data.emote_set?.emotes));
  } catch {
    return new Map();
  }
}

async function resolveTwitchUserId(login) {
  const body = [{
    operationName: "ChannelShell",
    variables: { login },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: "580ab410bcd0c1ad194224957ae2241e5d252b2c5173d8e0cce9d32d5bb14efe",
      },
    },
  }];

  const response = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "client-id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return "";
  const data = await response.json();
  return data?.[0]?.data?.userOrError?.id || data?.[0]?.data?.user?.id || "";
}

async function fetchBttvChannelEmotes(userId) {
  if (!userId) return new Map();
  try {
    const data = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${userId}`);
    const emotes = [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
    return new Map(emotes.map(bttvEmoteEntry));
  } catch {
    return new Map();
  }
}

function extractYouTubeVideoId(input) {
  const value = cleanInput(input);
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  const url = parseMaybeUrl(value);
  if (!url || !url.hostname.includes("youtu")) return "";

  const fromQuery = url.searchParams.get("v");
  if (fromQuery) return fromQuery;

  const parts = pathParts(url);
  if (url.hostname.includes("youtu.be")) return parts[0] || "";
  if (["live", "embed", "shorts"].includes(parts[0])) return parts[1] || "";
  return "";
}

async function resolveYouTubeWatchUrl(input) {
  const videoId = extractYouTubeVideoId(input);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

  const value = cleanInput(input);
  if (!value) throw new Error("missing YouTube source");

  const liveUrls = [];
  const bareHandle = value.startsWith("@")
    ? value.slice(1)
    : !value.includes("://") && !value.includes("/") && !value.includes(".")
      ? value
      : "";

  if (bareHandle) {
    const handle = bareHandle.replace(/^@/, "");
    liveUrls.push(
      `https://www.youtube.com/@${encodeURIComponent(handle)}/live`,
      `https://www.youtube.com/c/${encodeURIComponent(handle)}/live`,
      `https://www.youtube.com/user/${encodeURIComponent(handle)}/live`,
    );
  } else {
    let urlValue = value;
    if (!urlValue.includes("://")) urlValue = `https://${urlValue}`;

    const url = new URL(urlValue);
    if (!url.hostname.includes("youtube.com") && !url.hostname.includes("youtu.be")) {
      throw new Error("not a YouTube URL or handle");
    }

    if (url.hostname.includes("youtu.be")) {
      const shortId = pathParts(url)[0];
      if (shortId) return `https://www.youtube.com/watch?v=${shortId}`;
    }

    let livePath = url.pathname || "/";
    if (!livePath.endsWith("/live")) livePath = `${livePath.replace(/\/$/, "")}/live`;
    liveUrls.push(`https://www.youtube.com${livePath}`);
  }

  for (const liveUrl of liveUrls) {
    const response = await fetch(liveUrl, { headers: browserHeaders() });
    const html = await response.text();
    if (html.includes("/sorry/") || response.url.includes("/sorry/")) {
      throw new Error("YouTube rate limited this IP");
    }

    const redirectVideoId = extractYouTubeVideoId(response.url);
    const htmlVideoId = html.match(/(?:"videoId"|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
    const resolved = redirectVideoId || htmlVideoId;
    if (resolved) return `https://www.youtube.com/watch?v=${resolved}`;
  }

  throw new Error(`no active public YouTube live stream found for ${value}`);
}

function youtubeLiveChatUrl(watchUrl) {
  const videoId = extractYouTubeVideoId(watchUrl);
  return videoId ? `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1` : "";
}

async function fetchYouTubeInitialPage(pageUrl) {
  const response = await fetch(pageUrl, { headers: browserHeaders() });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status}`);
  }

  if (html.includes("/sorry/") || response.url.includes("/sorry/")) {
    throw new Error("YouTube rate limited this IP");
  }

  const cfgJson = extractBalancedJson(html, "ytcfg.set({");
  const initialJson = extractBalancedJson(html, "var ytInitialData =") || extractBalancedJson(html, "window[\"ytInitialData\"] =");
  if (!cfgJson || !initialJson) {
    throw new Error("YouTube page config not found");
  }

  return {
    cfgRaw: JSON.parse(cfgJson),
    initialData: JSON.parse(initialJson),
  };
}

function findYouTubeContinuation(initialData) {
  let continuation = getByPath(initialData, [
    "contents",
    "twoColumnWatchNextResults",
    "conversationBar",
    "liveChatRenderer",
    "continuations",
    0,
    "reloadContinuationData",
    "continuation",
  ]);

  continuation ||= getByPath(initialData, [
    "contents",
    "twoColumnWatchNextResults",
    "conversationBar",
    "liveChatRenderer",
    "continuations",
    0,
    "invalidationContinuationData",
    "continuation",
  ]);

  continuation ||= getByPath(initialData, [
    "continuationContents",
    "liveChatContinuation",
    "continuations",
    0,
    "reloadContinuationData",
    "continuation",
  ]);

  continuation ||= getByPath(initialData, [
    "continuationContents",
    "liveChatContinuation",
    "continuations",
    0,
    "invalidationContinuationData",
    "continuation",
  ]);

  continuation ||= findFirstByKey(initialData, "reloadContinuationData")?.continuation;
  continuation ||= findFirstByKey(initialData, "invalidationContinuationData")?.continuation;
  return continuation || "";
}

function normalizeTwitchChannel(input) {
  const url = parseMaybeUrl(input);
  let channel = cleanHandle(input);
  if (url && url.hostname.includes("twitch.tv")) {
    const parts = pathParts(url);
    channel = parts[0] === "popout" ? parts[1] : parts[0];
  }
  return channel.toLowerCase();
}

function normalizeKickSlug(input) {
  const url = parseMaybeUrl(input);
  let slug = cleanHandle(input);
  if (url && url.hostname.includes("kick.com")) {
    const parts = pathParts(url);
    slug = parts[0] === "popout" ? parts[1] : parts[0];
  }
  return slug.toLowerCase();
}

// Periscope/X broadcast IDs are 13-char high-entropy base62 (e.g. 1yNGaQLWpejGj).
// Require an uppercase letter or digit so plain lowercase usernames aren't mistaken for IDs.
function looksLikeXBroadcastId(value) {
  return /^[A-Za-z0-9]{13}$/.test(value) && /[A-Z0-9]/.test(value);
}

function normalizeXBroadcastId(input) {
  const url = parseMaybeUrl(input);
  if (url && /(^|\.)(x\.com|twitter\.com|pscp\.tv|periscope\.tv)$/.test(url.hostname)) {
    const parts = pathParts(url);
    const broadcastsIndex = parts.indexOf("broadcasts");
    if (broadcastsIndex !== -1 && parts[broadcastsIndex + 1]) return parts[broadcastsIndex + 1];
  }
  const value = cleanInput(input);
  return looksLikeXBroadcastId(value) ? value : "";
}

function normalizeXHandle(input) {
  const url = parseMaybeUrl(input);
  if (url && /(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) {
    const parts = pathParts(url);
    if (parts[0] && !["i", "home", "search", "explore"].includes(parts[0])) return parts[0];
  }
  return cleanHandle(input);
}

async function xGraphql(queryId, operation, variables, guestToken) {
  // Broad feature set; X only checks these keys exist, not their semantics for guests.
  const features = {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
  };
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });
  return fetchJson(`https://x.com/i/api/graphql/${queryId}/${operation}?${params.toString()}`, {
    headers: xApiHeaders(guestToken),
  });
}

async function resolveXUserId(handle, guestToken) {
  const key = handle.toLowerCase();
  const cached = xUserIdCache.get(key);
  if (cached) return cached;
  const data = await xGraphql(X_GRAPHQL_USER_BY_SCREEN_NAME, "UserByScreenName", { screen_name: handle }, guestToken);
  const userId = data?.data?.user?.result?.rest_id;
  if (!userId) throw new Error(`X user not found: @${handle}`);
  xUserIdCache.set(key, userId);
  return userId;
}

// A live broadcast surfaces as a card in one of the user's recent tweets. Rather than
// parse the (changeable) card schema, pull broadcast-id candidates from the timeline
// JSON and let bootstrap's show.json state check confirm which one is actually live.
function extractXBroadcastIdCandidates(timelineText) {
  const ids = new Set();
  for (const match of timelineText.matchAll(/broadcasts\\?\/([A-Za-z0-9]{13})/g)) ids.add(match[1]);
  for (const match of timelineText.matchAll(/"broadcast_id"\s*:\s*"([A-Za-z0-9]{13})"/g)) ids.add(match[1]);
  return [...ids];
}

async function findLiveXBroadcast(handle, guestToken) {
  const userId = await resolveXUserId(handle, guestToken);
  const timeline = await xGraphql(X_GRAPHQL_USER_TWEETS, "UserTweets", {
    userId,
    count: 20,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: false,
    withV2Timeline: true,
  }, guestToken);

  const candidates = extractXBroadcastIdCandidates(JSON.stringify(timeline));
  for (const broadcastId of candidates) {
    try {
      const show = await fetchJson(
        `https://x.com/i/api/1.1/broadcasts/show.json?ids=${encodeURIComponent(broadcastId)}`,
        { headers: xApiHeaders(guestToken) },
      );
      const state = String(show?.broadcasts?.[broadcastId]?.state || "").toUpperCase();
      if (state === "RUNNING") return broadcastId;
    } catch {
      // Skip unverifiable candidates and keep scanning.
    }
  }
  return "";
}

// Accepts a broadcast URL/ID directly, or an @handle that we resolve to the user's
// currently-live broadcast.
async function resolveXBroadcastId(input) {
  const direct = normalizeXBroadcastId(input);
  if (direct) return direct;

  const handle = normalizeXHandle(input);
  if (!handle) {
    const error = new Error("enter an X username or broadcast link");
    error.permanent = true;
    throw error;
  }

  const guestToken = await getXGuestToken();
  const broadcastId = await findLiveXBroadcast(handle, guestToken);
  if (!broadcastId) {
    const error = new Error(`@${handle} has no live X broadcast right now`);
    error.permanent = true;
    throw error;
  }
  return broadcastId;
}

function xApiHeaders(guestToken = "") {
  return {
    authorization: `Bearer ${X_WEB_BEARER}`,
    accept: "application/json, text/plain, */*",
    "user-agent": browserHeaders()["user-agent"],
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    ...(guestToken ? { "x-guest-token": guestToken } : {}),
  };
}

function xChatHeaders() {
  return {
    accept: "*/*",
    origin: "https://x.com",
    referer: "https://x.com/",
    "content-type": "application/json",
    "x-periscope-user-agent": "Twitter/m5",
    "user-agent": browserHeaders()["user-agent"],
  };
}

async function getXGuestToken(force = false) {
  if (!force && xGuestToken && Date.now() - xGuestTokenAt < X_GUEST_TOKEN_TTL) return xGuestToken;
  const data = await fetchJson("https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    headers: xApiHeaders(),
  });
  if (!data?.guest_token) throw new Error("could not activate X guest token");
  xGuestToken = data.guest_token;
  xGuestTokenAt = Date.now();
  return xGuestToken;
}

// guest token -> broadcasts/show (media_key) -> live_video_stream/status (chatToken)
// -> accessChatPublic (chatman endpoint + access token). Retries once with a fresh
// guest token, since a cached one can expire and yields an empty broadcasts map.
async function bootstrapXBroadcastChat(broadcastId) {
  let lastError = null;

  for (const forceGuestToken of [false, true]) {
    try {
      const guestToken = await getXGuestToken(forceGuestToken);
      const show = await fetchJson(
        `https://x.com/i/api/1.1/broadcasts/show.json?ids=${encodeURIComponent(broadcastId)}`,
        { headers: xApiHeaders(guestToken) },
      );
      const broadcastInfo = show?.broadcasts?.[broadcastId];
      if (!broadcastInfo?.media_key) throw new Error(`X broadcast not found: ${broadcastId}`);

      const state = String(broadcastInfo.state || "").toUpperCase();
      if (state && state !== "RUNNING") {
        const stateError = new Error(`X broadcast is not live (${state.toLowerCase()})`);
        stateError.permanent = true;
        throw stateError;
      }

      const status = await fetchJson(
        `https://x.com/i/api/1.1/live_video_stream/status/${encodeURIComponent(broadcastInfo.media_key)}?client=web&use_syndication_guest_id=false&cookie_set_host=x.com`,
        { headers: xApiHeaders(guestToken) },
      );
      if (!status?.chatToken) throw new Error("X broadcast has no chat token");

      const access = await fetchJson("https://proxsee.pscp.tv/api/v2/accessChatPublic", {
        method: "POST",
        headers: xChatHeaders(),
        body: JSON.stringify({ chat_token: status.chatToken }),
      });
      const endpoint = access?.endpoint || access?.replay_endpoint;
      const accessToken = access?.access_token || access?.replay_access_token;
      if (!endpoint || !accessToken) throw new Error("could not resolve X chat endpoint");

      return { endpoint, accessToken, title: broadcastInfo.status || "" };
    } catch (error) {
      lastError = error;
      if (error.permanent) break;
    }
  }

  throw lastError || new Error("could not bootstrap X chat");
}

// Chatman frames: outer {kind, payload}; kind 1 carries a JSON payload whose `body`
// is itself JSON. Hearts/joins arrive the same way but with no text body.
function parseXChatFrame(frame) {
  if (frame?.kind !== 1 || !frame.payload) return null;

  let outer;
  try {
    outer = JSON.parse(frame.payload);
  } catch {
    return null;
  }

  let inner = outer?.body;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      return null;
    }
  }

  // inner.type: 1 = chat text, 2 = heart, 3 = join — only surface real chat.
  if (inner?.type !== undefined && inner.type !== 1) return null;

  const text = typeof inner?.body === "string" ? inner.body.trim() : "";
  if (!text) return null;

  let createdAt = Number(inner?.timestamp);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    createdAt = inner?.programDateTime ? Date.parse(inner.programDateTime) : Date.now();
  } else if (createdAt > 1e14) {
    createdAt = Math.floor(createdAt / 1e6);
  }

  const username = inner?.username || outer?.sender?.username || "";
  return {
    id: typeof inner?.uuid === "string" ? inner.uuid : "",
    author: inner?.displayName || outer?.sender?.display_name || username || "x",
    authorUrl: username ? `https://x.com/${encodeURIComponent(username)}` : "",
    text,
    avatar: inner?.profileImageURL || outer?.sender?.profile_image_url || "",
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}

class XConnector {
  constructor(source) {
    this.platform = "x";
    this.sourceId = source.id;
    this.input = cleanInput(source.value);
    this.broadcastId = "";
    this.ws = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.startedAt = 0;
    this.viewersTimer = null;
    this.lastKnownHandle = "";
    this.refreshing = false;
  }

  async pollViewers() {
    try {
      const guestToken = await getXGuestToken();
      const show = await fetchJson(
        `https://x.com/i/api/1.1/broadcasts/show.json?ids=${encodeURIComponent(this.broadcastId)}`,
        { headers: xApiHeaders(guestToken) },
      );
      const info = show?.broadcasts?.[this.broadcastId];
      if (info?.username) this.lastKnownHandle = info.username;

      const state = String(info?.state || "").toUpperCase();
      if (state === "RUNNING") {
        const watching = Number(info?.total_watching);
        if (Number.isFinite(watching)) emitViewers(this.sourceId, watching);
      } else if (state) {
        // Broadcast ended — drop the count and chase the channel's new one.
        emitViewers(this.sourceId, null);
        this.refreshBroadcast();
      }
    } catch {
      // Keep the last known count on transient failures.
    }
  }

  // X broadcasts die and restart under new IDs; when the tracked one ends,
  // look up the host's currently-live broadcast and reconnect chat to it.
  async refreshBroadcast() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const handle = this.lastKnownHandle || normalizeXHandle(this.input);
      if (!handle || looksLikeXBroadcastId(handle)) return;
      const guestToken = await getXGuestToken();
      const next = await findLiveXBroadcast(handle, guestToken);
      if (!next || next === this.broadcastId || this.closed) return;
      emitStatus("x", "connecting", `new broadcast ${next}`, this.sourceId);
      this.broadcastId = next;
      this.startedAt = Date.now();
      if (this.ws) {
        this.ws.close();
      } else {
        this.scheduleReconnect();
      }
    } catch {
      // Try again on the next viewers poll.
    } finally {
      this.refreshing = false;
    }
  }

  async start() {
    if (!this.input) {
      const error = new Error("enter an X username or broadcast link");
      error.permanent = true;
      throw error;
    }
    this.closed = false;
    this.startedAt = Date.now();
    emitStatus("x", "connecting", this.input, this.sourceId);
    this.broadcastId = await resolveXBroadcastId(this.input);
    clearInterval(this.viewersTimer);
    this.viewersTimer = setInterval(() => this.pollViewers(), 30_000);
    this.pollViewers();
    await this.connect();
  }

  async connect() {
    if (!this.broadcastId) this.broadcastId = await resolveXBroadcastId(this.input);
    const bootstrap = await bootstrapXBroadcastChat(this.broadcastId);
    if (this.closed) return;

    const wsUrl = `${bootstrap.endpoint.replace(/^http/, "ws").replace(/\/$/, "")}/chatapi/v1/chatnow`;
    const ws = new WebSocket(wsUrl, {
      headers: { origin: "https://x.com", "user-agent": browserHeaders()["user-agent"] },
    });
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({ payload: JSON.stringify({ access_token: bootstrap.accessToken }), kind: 3 }));
      ws.send(JSON.stringify({
        payload: JSON.stringify({ body: JSON.stringify({ room: this.broadcastId }), kind: 1 }),
        kind: 2,
      }));
      emitStatus("x", "connected", bootstrap.title || this.broadcastId, this.sourceId);
    });

    ws.on("message", (buffer) => {
      let frame;
      try {
        frame = JSON.parse(String(buffer));
      } catch {
        return;
      }
      const message = parseXChatFrame(frame);
      if (!message) return;
      if (message.createdAt < this.startedAt - LIVE_BACKFILL_WINDOW_MS) return;
      emitMessage({ ...message, sourceId: this.sourceId, platform: "x" });
    });

    ws.on("error", (error) => emitStatus("x", "error", error.message, this.sourceId));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    emitStatus("x", "connecting", `reconnecting ${this.broadcastId}`, this.sourceId);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        emitStatus("x", "error", error.message, this.sourceId);
        if (!error.permanent) this.scheduleReconnect();
      });
    }, 3000);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearInterval(this.viewersTimer);
    this.viewersTimer = null;
    this.ws?.close();
    this.ws = null;
    emitStatus("x", "stopped", this.broadcastId, this.sourceId);
  }
}

class TwitchConnector {
  constructor(source) {
    this.platform = "twitch";
    this.sourceId = source.id;
    this.channel = normalizeTwitchChannel(source.value);
    this.ws = null;
    this.closed = false;
    this.bttvEmotes = new Map();
    this.badgeMap = new Map();
    this.viewersTimer = null;
  }

  async pollViewers() {
    try {
      const data = await twitchGql(`{ user(login: ${JSON.stringify(this.channel)}) { stream { viewersCount } } }`);
      emitViewers(this.sourceId, data?.data?.user?.stream?.viewersCount ?? null);
    } catch {
      // Keep the last known count on transient failures.
    }
  }

  async start() {
    if (!this.channel) throw new Error("missing Twitch channel");
    this.closed = false;
    emitStatus("twitch", "connecting", this.channel, this.sourceId);
    await this.loadBttvEmotes();

    const nick = `justinfan${Math.floor(Math.random() * 80000 + 1000)}`;
    this.ws = new WebSocket(TWITCH_IRC_URL);

    this.ws.on("open", () => {
      this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.ws.send("PASS SCHMOOPIIE");
      this.ws.send(`NICK ${nick}`);
      this.ws.send(`JOIN #${this.channel}`);
      emitStatus("twitch", "connected", this.channel, this.sourceId);
    });

    clearInterval(this.viewersTimer);
    this.viewersTimer = setInterval(() => this.pollViewers(), 30_000);
    this.pollViewers();

    this.ws.on("message", (buffer) => {
      String(buffer).split("\r\n").filter(Boolean).forEach((line) => this.handleLine(line));
    });

    this.ws.on("error", (error) => emitStatus("twitch", "error", error.message, this.sourceId));
    this.ws.on("close", () => {
      if (!this.closed) emitStatus("twitch", "disconnected", this.channel, this.sourceId);
    });
  }

  async loadBttvEmotes() {
    const userId = await resolveTwitchUserId(this.channel).catch(() => "");
    const [ffzGlobal, bttvGlobal, sevenTvGlobal, ffzChannel, bttvChannel, sevenTvChannel, twitchGlobalBadgeMap, twitchChannelBadgeMap] = await Promise.all([
      fetchFfzGlobalEmotes(),
      fetchBttvGlobalEmotes(),
      fetchSevenTvGlobalEmotes(),
      fetchFfzChannelEmotes(this.channel),
      fetchBttvChannelEmotes(userId),
      fetchSevenTvChannelEmotes(userId),
      fetchTwitchGlobalBadges(),
      fetchTwitchChannelBadges(this.channel),
    ]);
    this.badgeMap = new Map([...twitchGlobalBadgeMap, ...twitchChannelBadgeMap]);
    this.bttvEmotes = new Map([
      ...ffzGlobal,
      ...bttvGlobal,
      ...sevenTvGlobal,
      ...ffzChannel,
      ...bttvChannel,
      ...sevenTvChannel,
    ]);
  }

  handleLine(line) {
    if (line.startsWith("PING")) {
      this.ws?.send("PONG :tmi.twitch.tv");
      return;
    }

    const tagMatch = line.match(/^@([^ ]+) /);
    const tags = {};
    if (tagMatch) {
      tagMatch[1].split(";").forEach((pair) => {
        const [key, value = ""] = pair.split("=");
        tags[key] = value.replace(/\\s/g, " ");
      });
    }

    if (line.includes(" USERNOTICE ")) {
      this.handleUserNotice(line, tags);
      return;
    }

    if (!line.includes(" PRIVMSG ")) return;

    const text = line.split(" PRIVMSG ")[1]?.split(" :").slice(1).join(" :") || "";
    // Strip the tags first: tag values (e.g. flags) can contain ":", which made
    // a prefix-anchored match against the full line capture tag garbage.
    const rest = tagMatch ? line.slice(tagMatch[0].length) : line;
    const login = rest.match(/^:([^!]+)!/)?.[1] || "";
    const author = tags["display-name"] || login || "twitch";
    if (!text) return;

    const bits = Number(tags.bits) || 0;

    emitMessage({
      sourceId: this.sourceId,
      platform: "twitch",
      id: tags.id,
      author,
      authorUrl: login ? `https://www.twitch.tv/${login}` : "",
      text,
      parts: buildTwitchParts(text, tags.emotes, this.bttvEmotes),
      color: tags.color,
      badges: parseTwitchBadges(tags.badges, this.badgeMap),
      createdAt: Number(tags["tmi-sent-ts"]) || Date.now(),
      kind: bits ? "event" : "chat",
      event: bits ? { type: "bits", label: `cheered ${bits} bits` } : null,
      raw: { tags },
    });
  }

  handleUserNotice(line, tags) {
    const eventTypes = {
      sub: "sub",
      resub: "sub",
      subgift: "giftsub",
      submysterygift: "giftsub",
      giftpaidupgrade: "sub",
      primepaidupgrade: "sub",
      anongiftpaidupgrade: "sub",
    };
    const type = eventTypes[tags["msg-id"]];
    if (!type) return;

    const author = tags["display-name"] || tags.login || "twitch";
    const authorUrl = tags.login ? `https://www.twitch.tv/${tags.login}` : "";
    let label = (tags["system-msg"] || "").trim();
    if (label.toLowerCase().startsWith(author.toLowerCase())) {
      label = label.slice(author.length).trim();
    }
    if (!label) label = type === "giftsub" ? "gifted a sub" : "subscribed";

    const text = line.split(" USERNOTICE ")[1]?.split(" :").slice(1).join(" :") || "";

    emitMessage({
      sourceId: this.sourceId,
      platform: "twitch",
      id: tags.id,
      author,
      authorUrl,
      text,
      parts: text ? buildTwitchParts(text, tags.emotes, this.bttvEmotes) : undefined,
      color: tags.color,
      badges: parseTwitchBadges(tags.badges, this.badgeMap),
      createdAt: Number(tags["tmi-sent-ts"]) || Date.now(),
      kind: "event",
      event: { type, label },
      raw: { tags },
    });
  }

  stop() {
    this.closed = true;
    clearInterval(this.viewersTimer);
    this.viewersTimer = null;
    this.ws?.close();
    this.ws = null;
    emitStatus("twitch", "stopped", this.channel, this.sourceId);
  }
}

class KickConnector {
  constructor(source) {
    this.platform = "kick";
    this.sourceId = source.id;
    this.slug = normalizeKickSlug(source.value);
    this.connection = null;
    this.ws = null;
    this.chatroomId = 0;
    this.closed = false;
    this.startedAt = 0;
  }

  async start() {
    if (!this.slug) throw new Error("missing Kick channel");
    this.closed = false;
    this.startedAt = Date.now();
    emitStatus("kick", "connecting", this.slug, this.sourceId);

    this.connection = new KickConnection(this.slug);
    this.connection.on(KickEvents.Connected, (state) => emitStatus("kick", "connected", `room ${state.roomID}`, this.sourceId));
    this.connection.on(KickEvents.Disconnected, () => {
      if (!this.closed) emitStatus("kick", "disconnected", this.slug, this.sourceId);
    });
    this.connection.on(KickEvents.Error, (error) => emitStatus("kick", "error", error?.message || String(error), this.sourceId));
    this.connection.on(KickEvents.ChatMessage, (message) => this.handleMessage(message));
    this.connection.on(KickEvents.Subscription, (data) => this.handleSubscription(data));
    this.connection.on(KickEvents.GiftedSubscriptions, (data) => this.handleGiftedSubscriptions(data));
    this.connection.on(KickEvents.ViewerCount, (data) => emitViewers(this.sourceId, data?.viewers));

    try {
      const status = await withTimeout(
        this.connection.connect(),
        12_000,
        `Kick did not connect: ${this.slug}`,
      );
      if (status?.roomID) emitStatus("kick", "connected", `room ${status.roomID}`, this.sourceId);
      this.connection.startViewerCountUpdates();
    } catch (error) {
      if (!/offline/i.test(String(error?.message || ""))) throw error;
      // The library refuses offline channels, but Kick chatrooms keep working
      // while the stream is down — subscribe to the chatroom socket directly.
      this.connection.disconnect?.();
      this.connection = null;
      await this.connectDirect();
    }
  }

  async connectDirect() {
    const chatroom = await kickApiFetch(`https://kick.com/api/v2/channels/${encodeURIComponent(this.slug)}/chatroom`);
    if (!chatroom?.id) throw new Error(`Kick chatroom not found: ${this.slug}`);
    this.chatroomId = chatroom.id;
    this.openDirectSocket();
  }

  openDirectSocket() {
    if (this.closed) return;
    const ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false");
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${this.chatroomId}.v2` } }));
      emitStatus("kick", "connected", `room ${this.chatroomId} (stream offline)`, this.sourceId);
    });

    ws.on("message", (buffer) => {
      let frame;
      try {
        frame = JSON.parse(String(buffer));
      } catch {
        return;
      }
      if (frame.event === "pusher:ping") {
        ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        return;
      }
      let payload = frame.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      const eventName = String(frame.event || "").split("\\").pop();
      if (eventName === "ChatMessageEvent") this.handleMessage(payload);
      else if (eventName === "SubscriptionEvent") this.handleSubscription(payload);
      else if (eventName === "GiftedSubscriptionsEvent") this.handleGiftedSubscriptions(payload);
    });

    ws.on("error", (error) => emitStatus("kick", "error", error.message, this.sourceId));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      if (!this.closed && this.chatroomId) {
        setTimeout(() => this.openDirectSocket(), 3000);
      }
    });
  }

  handleMessage(message) {
    const parts = buildKickParts(message.content);
    const text = parts
      .map((part) => (part.type === "emote" ? `:${part.name}:` : part.text))
      .join("");
    if (!text.trim()) return;
    const createdAt = message.created_at ? Date.parse(message.created_at) : Date.now();
    if (Number.isFinite(createdAt) && createdAt < this.startedAt - LIVE_BACKFILL_WINDOW_MS) return;

    emitMessage({
      sourceId: this.sourceId,
      platform: "kick",
      id: message.id,
      author: message.sender?.username || message.sender?.slug || "kick",
      authorUrl: message.sender?.slug
        ? `https://kick.com/${message.sender.slug}`
        : message.sender?.username
          ? `https://kick.com/${encodeURIComponent(message.sender.username)}`
          : "",
      text,
      parts,
      color: message.sender?.identity?.color || "",
      badges: kickBadges(message.sender?.identity),
      createdAt,
      raw: message,
    });
  }

  handleSubscription(data) {
    const months = Number(data?.months) || 0;
    emitMessage({
      sourceId: this.sourceId,
      platform: "kick",
      author: data?.username || "kick",
      authorUrl: data?.username ? `https://kick.com/${encodeURIComponent(data.username)}` : "",
      kind: "event",
      event: { type: "sub", label: months > 1 ? `subscribed for ${months} months` : "subscribed" },
      raw: data,
    });
  }

  handleGiftedSubscriptions(data) {
    const count = Array.isArray(data?.gifted_usernames) ? data.gifted_usernames.length : 1;
    emitMessage({
      sourceId: this.sourceId,
      platform: "kick",
      author: data?.gifter_username || "kick",
      authorUrl: data?.gifter_username ? `https://kick.com/${encodeURIComponent(data.gifter_username)}` : "",
      kind: "event",
      event: { type: "giftsub", label: `gifted ${count} sub${count === 1 ? "" : "s"}` },
      raw: data,
    });
  }

  stop() {
    this.closed = true;
    this.connection?.stopViewerCountUpdates();
    this.connection?.disconnect();
    this.connection = null;
    this.ws?.close();
    this.ws = null;
    emitStatus("kick", "stopped", this.slug, this.sourceId);
  }
}

class YouTubeConnector {
  constructor(source) {
    this.platform = "youtube";
    this.sourceId = source.id;
    this.input = cleanInput(source.value);
    this.stopped = false;
    this.startedAt = 0;
    this.viewersTimer = null;
  }

  async pollViewers() {
    try {
      const videoId = extractYouTubeVideoId(this.watchUrl);
      if (!videoId || !this.cfg) return;
      const url = new URL("https://www.youtube.com/youtubei/v1/updated_metadata");
      if (this.cfg.apiKey) url.searchParams.set("key", this.cfg.apiKey);
      const response = await fetch(url, {
        method: "POST",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ context: this.cfg.context, videoId }),
      });
      const data = await response.json();
      const viewCount = findFirstByKey(data, "videoViewCountRenderer")?.viewCount;
      const text = runsToText(viewCount || {}) || viewCount?.simpleText || "";
      const count = Number(String(text).replace(/[^0-9]/g, ""));
      if (text && Number.isFinite(count)) emitViewers(this.sourceId, count);
    } catch {
      // Keep the last known count on transient failures.
    }
  }

  async start() {
    if (!this.input) throw new Error("missing YouTube source");
    this.stopped = false;
    this.startedAt = Date.now();
    emitStatus("youtube", "connecting", this.input, this.sourceId);

    const watchUrl = await resolveYouTubeWatchUrl(this.input);
    const initial = await this.fetchInitialData(watchUrl);
    this.watchUrl = watchUrl;
    this.continuation = initial.continuation;
    this.cfg = initial.cfg;
    emitStatus("youtube", "connected", watchUrl, this.sourceId);
    this.pollLoop();
    clearInterval(this.viewersTimer);
    this.viewersTimer = setInterval(() => this.pollViewers(), 60_000);
    this.pollViewers();
  }

  async fetchInitialData(watchUrl) {
    const pageUrls = [watchUrl, youtubeLiveChatUrl(watchUrl)].filter(Boolean);
    let lastError = null;
    let cfgRaw = null;
    let continuation = "";

    for (const pageUrl of pageUrls) {
      try {
        const page = await fetchYouTubeInitialPage(pageUrl);
        cfgRaw = page.cfgRaw;
        continuation = findYouTubeContinuation(page.initialData);
        if (continuation) break;
        lastError = new Error("YouTube live chat continuation not found");
      } catch (error) {
        lastError = error;
      }
    }

    if (!cfgRaw || !continuation) {
      throw lastError || new Error("YouTube live chat continuation not found");
    }

    return {
      continuation,
      cfg: {
        apiKey: cfgRaw.INNERTUBE_API_KEY,
        context: cfgRaw.INNERTUBE_CONTEXT,
        visitorData: cfgRaw.VISITOR_DATA,
        clientName: cfgRaw.INNERTUBE_CONTEXT_CLIENT_NAME,
        clientVersion: cfgRaw.INNERTUBE_CLIENT_VERSION,
      },
    };
  }

  async pollLoop() {
    while (!this.stopped) {
      try {
        const { messages, nextContinuation, timeoutMs } = await this.pollOnce();
        const liveMessages = messages
          .filter((message) => !message.createdAt || message.createdAt >= this.startedAt - LIVE_BACKFILL_WINDOW_MS);
        if (liveMessages.length > 1) {
          console.log(`[youtube:${this.sourceId}] received ${liveMessages.length} messages in one poll response`);
        }
        liveMessages.forEach((message) => emitMessage({ ...message, sourceId: this.sourceId }));
        if (nextContinuation) this.continuation = nextContinuation;
        await new Promise((resolve) => setTimeout(resolve, Math.max(timeoutMs || 2000, 1000)));
      } catch (error) {
        emitStatus("youtube", "error", error.message, this.sourceId);
        await new Promise((resolve) => setTimeout(resolve, 8000));
        try {
          const initial = await this.fetchInitialData(this.watchUrl);
          this.continuation = initial.continuation;
          this.cfg = initial.cfg;
        } catch {
          // Keep the outer loop retrying.
        }
      }
    }
  }

  async pollOnce() {
    const url = new URL("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat");
    if (this.cfg.apiKey) url.searchParams.set("key", this.cfg.apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/json",
        "x-goog-visitor-id": this.cfg.visitorData || "",
        "x-youtube-client-name": String(this.cfg.clientName || ""),
        "x-youtube-client-version": this.cfg.clientVersion || "",
      }),
      body: JSON.stringify({
        context: this.cfg.context || {
          client: {
            clientName: "WEB",
            clientVersion: this.cfg.clientVersion,
          },
        },
        continuation: this.continuation,
      }),
    });

    const body = await response.text();
    if (body.trim().startsWith("<")) throw new Error("YouTube returned HTML instead of chat JSON");
    const data = JSON.parse(body);
    const continuationBlock = data.continuationContents?.liveChatContinuation;
    const actions = continuationBlock?.actions || [];
    const messages = actions.map((action) => this.parseAction(action)).filter(Boolean);
    const continuation = continuationBlock?.continuations?.[0] || {};
    const nextContinuation = continuation.timedContinuationData?.continuation ||
      continuation.invalidationContinuationData?.continuation ||
      continuation.reloadContinuationData?.continuation ||
      "";
    const timeoutMs = continuation.timedContinuationData?.timeoutMs ||
      continuation.invalidationContinuationData?.timeoutMs ||
      continuation.reloadContinuationData?.timeoutMs ||
      2000;

    return { messages, nextContinuation, timeoutMs };
  }

  parseAction(action) {
    const item = action.addChatItemAction?.item;
    if (!item) return null;

    const giftRenderer = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
    const renderer = item.liveChatTextMessageRenderer ||
      item.liveChatPaidMessageRenderer ||
      item.liveChatPaidStickerRenderer ||
      item.liveChatMembershipItemRenderer ||
      giftRenderer;
    if (!renderer) return null;

    const giftHeader = giftRenderer?.header?.liveChatSponsorshipsHeaderRenderer;
    const author = renderer.authorName?.simpleText || giftHeader?.authorName?.simpleText || "youtube";

    let text = "";
    let parts = null;
    if (renderer.message) {
      text = runsToText(renderer.message);
      parts = runsToParts(renderer.message);
    }

    let event = null;
    if (item.liveChatPaidMessageRenderer || item.liveChatPaidStickerRenderer) {
      const amount = renderer.purchaseAmountText?.simpleText || "";
      const product = item.liveChatPaidStickerRenderer ? "Super Sticker" : "Super Chat";
      event = { type: "superchat", amount, label: amount ? `sent a ${amount} ${product}` : `sent a ${product}` };
    } else if (item.liveChatMembershipItemRenderer) {
      const label = runsToText(renderer.headerPrimaryText) || runsToText(renderer.headerSubtext) || "became a member";
      event = { type: "membership", label };
    } else if (giftRenderer) {
      event = { type: "giftsub", label: runsToText(giftHeader?.primaryText) || "gifted memberships" };
    }

    if (event && event.label.toLowerCase().startsWith(author.toLowerCase())) {
      event.label = event.label.slice(author.length).trim();
    }
    if (!event && !text) return null;

    const channelId = renderer.authorExternalChannelId || giftRenderer?.authorExternalChannelId || "";

    return {
      platform: "youtube",
      id: renderer.id,
      author,
      authorUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : "",
      text,
      parts: parts?.length ? parts : undefined,
      avatar: bestThumbnail(renderer.authorPhoto || giftHeader?.authorPhoto),
      badges: parseBadges(renderer.authorBadges),
      createdAt: renderer.timestampUsec ? Math.floor(Number(renderer.timestampUsec) / 1000) : Date.now(),
      kind: event ? "event" : "chat",
      event,
      raw: null,
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.viewersTimer);
    this.viewersTimer = null;
    emitStatus("youtube", "stopped", this.input, this.sourceId);
  }
}

function stopAll() {
  for (const connector of connectors.values()) {
    connector.stop();
  }
  connectors.clear();
  activeSources.clear();
  sourceStatuses.clear();
  viewerCounts.clear();
}

function stopConnector(sourceId) {
  const connector = connectors.get(sourceId);
  if (connector) {
    connector.stop();
    connectors.delete(sourceId);
  }
  activeSources.delete(sourceId);
  viewerCounts.delete(sourceId);
  broadcast("viewers", { sourceId, count: null });
}

function normalizeSources(sources = []) {
  const supportedPlatforms = new Set(["twitch", "youtube", "kick", "x"]);
  const sourceArray = Array.isArray(sources)
    ? sources
    : Object.entries(sources)
      .filter(([, value]) => cleanInput(value))
      .map(([platform, value]) => ({ id: platform, platform, value }));

  return sourceArray
    .map((source) => ({
      id: cleanInput(source.id),
      platform: cleanInput(source.platform).toLowerCase(),
      value: cleanInput(source.value),
      label: cleanInput(source.label).slice(0, 18),
      usernameColor: /^#[0-9a-f]{3,8}$/i.test(cleanInput(source.usernameColor))
        ? cleanInput(source.usernameColor)
        : "",
    }))
    .filter((source) => source.id && source.value && supportedPlatforms.has(source.platform));
}

async function reconcileConnectors(sources) {
  const normalizedSources = normalizeSources(sources);
  const nextById = new Map(normalizedSources.map((source) => [source.id, source]));
  const jobs = [];

  for (const [sourceId] of activeSources) {
    if (!nextById.has(sourceId)) {
      stopConnector(sourceId);
      resetSourceMessages(sourceId);
      sourceStatuses.delete(sourceId);
    }
  }

  for (const source of normalizedSources) {
    const currentSource = activeSources.get(source.id);
    const changed = !currentSource ||
      currentSource.platform !== source.platform ||
      currentSource.value !== source.value;

    if (!changed) {
      activeSources.set(source.id, source);
      const status = sourceStatuses.get(source.id);
      if (status) broadcast("status", status);
      continue;
    }

    if (connectors.has(source.id)) {
      stopConnector(source.id);
      resetSourceMessages(source.id);
    }

    activeSources.set(source.id, source);
    const connector = source.platform === "twitch"
      ? new TwitchConnector(source)
      : source.platform === "youtube"
        ? new YouTubeConnector(source)
        : source.platform === "x"
          ? new XConnector(source)
          : new KickConnector(source);
    jobs.push(startConnector(source, connector));
  }

  await Promise.allSettled(jobs);
  broadcast("sources", Array.from(activeSources.values()));
}

async function startConnector(source, connector) {
  connectors.set(source.id, connector);
  try {
    await connector.start();
  } catch (error) {
    connectors.delete(source.id);
    emitStatus(source.platform, "error", error.message, source.id);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/"
    ? "/index.html"
    : url.pathname === "/chat" || url.pathname === "/chat/"
      ? "/chat.html"
      : url.pathname === "/obschat" || url.pathname === "/obschat/"
        ? "/obschat.html"
        : url.pathname === "/watch" || url.pathname === "/watch/"
          ? "/watch.html"
          : url.pathname;
  const filePath = path.normalize(path.join(__dirname, pathname));

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".avif": "image/avif",
      ".svg": "image/svg+xml",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(res);
    sendSSE(res, "ready", {
      recentMessages,
      statuses: Array.from(sourceStatuses.values()),
      sources: Array.from(activeSources.values()),
      poll: publicPoll(),
      spotlight: activeSpotlight,
      obsStyle,
      viewers: Object.fromEntries(viewerCounts),
    });
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connect") {
    try {
      const body = await readJsonBody(req);
      await reconcileConnectors(body.sources || {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/watch-stream") {
    const channel = (cleanInput(url.searchParams.get("channel")) || "fazebanks").toLowerCase();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await resolveWatchStream(channel)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/avatar") {
    const avatar = await resolveAvatar(
      cleanInput(url.searchParams.get("platform")).toLowerCase(),
      cleanInput(url.searchParams.get("value")),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ avatar }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/user-messages") {
    const log = userMessageLog(
      cleanInput(url.searchParams.get("sourceId")),
      cleanInput(url.searchParams.get("author")),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: log }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/poll") {
    try {
      const body = await readJsonBody(req);
      startPoll(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, poll: publicPoll() }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/poll") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ poll: publicPoll() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/poll/stop") {
    endPoll();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, poll: publicPoll() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/poll/clear") {
    clearPoll();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/poll/display") {
    const body = await readJsonBody(req).catch(() => ({}));
    setPollDisplayMode(body.mode);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, poll: publicPoll() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/spotlight") {
    try {
      const body = await readJsonBody(req);
      startSpotlight(cleanInput(body.sourceId), cleanInput(body.author));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, spotlight: activeSpotlight }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/spotlight/scroll") {
    const body = await readJsonBody(req).catch(() => ({}));
    if (activeSpotlight) {
      const raw = Number(body.fraction);
      activeSpotlight.scrollFraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
      broadcast("spotlight-scroll", { fraction: activeSpotlight.scrollFraction });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/spotlight/stop") {
    stopSpotlight();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/obs-style") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ style: obsStyle }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/obs-style") {
    const body = await readJsonBody(req).catch(() => ({}));
    applyObsStyle(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, style: obsStyle }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    stopAll();
    recentMessages = [];
    seenMessageKeys.clear();
    messageLogs.clear();
    clearTimeout(pollEndTimer);
    activePoll = null;
    activeSpotlight = null;
    broadcast("reset", {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Chatbubble running at http://localhost:${PORT}`);
});
