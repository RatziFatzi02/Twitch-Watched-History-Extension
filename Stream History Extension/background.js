const HISTORY_KEY = "twhHistory";
const COUNTED_VISITS_KEY = "twhCountedVisits";
const TWITCH_AUTH_KEY = "twhTwitchAuth";
const DEFAULT_TWITCH_CLIENT_ID = "s8b8t5hgsfw6b9us21j71xq8gq6oac";
const HEARTBEAT_STALE_MS = 20000;
const MAX_PREVIEW_DATA_URL_LENGTH = 220000;
const MAX_RECENT_CATEGORIES = 5;
const MAX_RECENT_TAGS = 12;
const FOLLOWING_CHECKED_AT_KEY = "twhFollowingCheckedAt";

const INTERNAL_TWITCH_PATHS = new Set([
  "directory",
  "videos",
  "settings",
  "subscriptions",
  "drops",
  "inventory",
  "search",
  "p",
  "turbo",
  "popout",
  "moderator",
  "downloads",
  "jobs",
  "store",
  "wallet",
  "teams"
]);

const trackedTabs = new Map();
let focusedWindowId = null;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getRedirectUrl() {
  return chrome.identity.getRedirectURL("twitch");
}

async function readTwitchAuth() {
  const result = await storageGet(TWITCH_AUTH_KEY);
  return result[TWITCH_AUTH_KEY] || {};
}

async function writeTwitchAuth(auth) {
  await storageSet({ [TWITCH_AUTH_KEY]: auth || {} });
}

function sessionGet(keys) {
  return new Promise((resolve) => chrome.storage.session.get(keys, resolve));
}

function sessionSet(values) {
  return new Promise((resolve) => chrome.storage.session.set(values, resolve));
}

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
}

function getWindow(windowId) {
  return new Promise((resolve) => {
    chrome.windows.get(windowId, (windowInfo) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(windowInfo);
    });
  });
}

function getLastFocusedWindow() {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused((windowInfo) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(windowInfo);
    });
  });
}

function launchWebAuthFlow(details) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(details, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

function parseTwitchChannelUrl(urlValue) {
  if (!urlValue) {
    return null;
  }

  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    if (host !== "www.twitch.tv" && host !== "twitch.tv") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) {
      return null;
    }

    const channelName = decodeURIComponent(parts[0]).trim();
    const lowerName = channelName.toLowerCase();
    if (INTERNAL_TWITCH_PATHS.has(lowerName)) {
      return null;
    }

    if (!/^[a-zA-Z0-9_]{3,25}$/.test(channelName)) {
      return null;
    }

    return {
      channelName,
      key: lowerName
    };
  } catch (error) {
    return null;
  }
}

function mergeDefined(base, patch) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeCategoryName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTagName(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > 40 ? clean.slice(0, 40) : clean;
}

function normalizeStreamTitle(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

function normalizeViewerCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
}

function isSafePreviewDataUrl(value) {
  return (
    typeof value === "string" &&
    value.length > 100 &&
    value.length <= MAX_PREVIEW_DATA_URL_LENGTH &&
    /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(value)
  );
}

function isSafeRemoteImageUrl(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 3000) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.href.startsWith("https://www.twitch.tv/");
  } catch (error) {
    return false;
  }
}

function mergeRecentCategories(existingCategories, state, nowIso) {
  const existing = Array.isArray(existingCategories) ? existingCategories : [];
  const categoryName = normalizeCategoryName(state.categoryName);
  if (!categoryName) {
    return existing.slice(0, MAX_RECENT_CATEGORIES);
  }

  const categoryKey = categoryName.toLowerCase();
  const next = existing.filter((category) => {
    return normalizeCategoryName(category.name).toLowerCase() !== categoryKey;
  });

  next.unshift({
    name: categoryName,
    url: state.categoryUrl || "",
    lastSeenAt: nowIso
  });

  return next.slice(0, MAX_RECENT_CATEGORIES);
}

function mergeRecentTags(existingTags, state, nowIso) {
  const existing = Array.isArray(existingTags) ? existingTags : [];
  const incomingTags = Array.isArray(state.tags) ? state.tags : [];
  let next = existing.slice(0, MAX_RECENT_TAGS);

  for (const rawTag of incomingTags) {
    const tagName = normalizeTagName(rawTag);
    if (!tagName) {
      continue;
    }

    const tagKey = tagName.toLowerCase();
    next = next.filter((tag) => normalizeTagName(tag.name || tag).toLowerCase() !== tagKey);
    next.unshift({
      name: tagName,
      lastSeenAt: nowIso
    });
  }

  return next.slice(0, MAX_RECENT_TAGS);
}

async function readHistory() {
  const result = await storageGet(HISTORY_KEY);
  return result[HISTORY_KEY] || {};
}

async function writeHistory(history) {
  await storageSet({ [HISTORY_KEY]: history });
}

async function hasVisitBeenCounted(visitId) {
  if (!visitId) {
    return false;
  }
  const result = await sessionGet(COUNTED_VISITS_KEY);
  const countedVisits = result[COUNTED_VISITS_KEY] || {};
  return Boolean(countedVisits[visitId]);
}

async function markVisitCounted(visitId) {
  if (!visitId) {
    return;
  }
  const result = await sessionGet(COUNTED_VISITS_KEY);
  const countedVisits = result[COUNTED_VISITS_KEY] || {};
  countedVisits[visitId] = Date.now();
  await sessionSet({ [COUNTED_VISITS_KEY]: countedVisits });
}

async function updateChannelRecord(state, patch) {
  const nowIso = new Date().toISOString();
  const history = await readHistory();
  const current = history[state.channelKey] || {
    channelName: state.channelName,
    displayName: state.displayName || state.channelName,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    totalWatchSeconds: 0,
    sessionCount: 0,
    lastUrl: state.url,
    pageTitle: state.pageTitle || "",
    lastStreamTitle: normalizeStreamTitle(state.lastStreamTitle),
    isLive: state.liveStatusKnown ? state.isLive === true : false,
    liveStatusCheckedAt: state.liveStatusKnown ? nowIso : "",
    viewerCount: normalizeViewerCount(state.viewerCount),
    viewerCountCheckedAt: normalizeViewerCount(state.viewerCount) !== null ? nowIso : "",
    profileImageUrl: state.profileImageUrl || "",
    bannerImageUrl: state.bannerImageUrl || "",
    imagesVerifiedAt: state.imagesVerified ? nowIso : "",
    previewImageDataUrl: isSafePreviewDataUrl(state.previewImageDataUrl) ? state.previewImageDataUrl : "",
    previewCapturedAt: isSafePreviewDataUrl(state.previewImageDataUrl) ? nowIso : "",
    recentCategories: [],
    recentTags: []
  };

  const hasPreviewCapture = isSafePreviewDataUrl(state.previewImageDataUrl);

  history[state.channelKey] = mergeDefined({
    ...current,
    channelName: state.channelName,
    displayName: state.displayName || current.displayName || state.channelName,
    lastSeenAt: patch.lastSeenAt || nowIso,
    totalWatchSeconds: Math.max(0, current.totalWatchSeconds + (patch.addSeconds || 0)),
    sessionCount: current.sessionCount + (patch.addSession ? 1 : 0),
    lastUrl: state.url || current.lastUrl,
    pageTitle: state.pageTitle || current.pageTitle || "",
    lastStreamTitle: normalizeStreamTitle(state.lastStreamTitle) || current.lastStreamTitle || "",
    isLive: state.liveStatusKnown ? state.isLive === true : current.isLive,
    liveStatusCheckedAt: state.liveStatusKnown ? nowIso : current.liveStatusCheckedAt,
    viewerCount: normalizeViewerCount(state.viewerCount) !== null ? normalizeViewerCount(state.viewerCount) : current.viewerCount,
    viewerCountCheckedAt: normalizeViewerCount(state.viewerCount) !== null ? nowIso : current.viewerCountCheckedAt,
    recentCategories: mergeRecentCategories(current.recentCategories, state, nowIso),
    recentTags: mergeRecentTags(current.recentTags, state, nowIso)
  }, {
    profileImageUrl: state.profileImageUrl || current.profileImageUrl,
    bannerImageUrl: state.bannerImageUrl || current.bannerImageUrl,
    imagesVerifiedAt: state.imagesVerified ? nowIso : current.imagesVerifiedAt,
    previewImageDataUrl: hasPreviewCapture ? state.previewImageDataUrl : current.previewImageDataUrl,
    previewCapturedAt: hasPreviewCapture ? nowIso : current.previewCapturedAt
  });

  await writeHistory(history);
}

async function mergeCapturedPreview(record) {
  if (!record || !record.channelKey || !/^[a-z0-9_]{3,25}$/.test(record.channelKey)) {
    return;
  }

  if (!isSafePreviewDataUrl(record.previewImageDataUrl)) {
    return;
  }

  const nowIso = new Date().toISOString();
  const history = await readHistory();
  const current = history[record.channelKey] || {
    channelName: record.channelName || record.channelKey,
    displayName: record.displayName || record.channelName || record.channelKey,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    totalWatchSeconds: 0,
    sessionCount: 0,
    lastUrl: record.url || "",
    pageTitle: record.pageTitle || "",
    lastStreamTitle: normalizeStreamTitle(record.lastStreamTitle),
    isLive: record.liveStatusKnown ? record.isLive === true : false,
    liveStatusCheckedAt: record.liveStatusKnown ? nowIso : "",
    viewerCount: normalizeViewerCount(record.viewerCount),
    viewerCountCheckedAt: normalizeViewerCount(record.viewerCount) !== null ? nowIso : "",
    profileImageUrl: "",
    bannerImageUrl: "",
    imagesVerifiedAt: "",
    previewImageDataUrl: "",
    previewCapturedAt: "",
    recentCategories: [],
    recentTags: []
  };

  history[record.channelKey] = mergeDefined({
    ...current,
    channelName: record.channelName || current.channelName,
    displayName: record.displayName || current.displayName,
    lastSeenAt: record.capturedAt || nowIso,
    lastUrl: record.url || current.lastUrl,
    pageTitle: record.pageTitle || current.pageTitle || "",
    lastStreamTitle: normalizeStreamTitle(record.lastStreamTitle) || current.lastStreamTitle || "",
    isLive: record.liveStatusKnown ? record.isLive === true : current.isLive,
    liveStatusCheckedAt: record.liveStatusKnown ? record.capturedAt || nowIso : current.liveStatusCheckedAt,
    viewerCount: normalizeViewerCount(record.viewerCount) !== null ? normalizeViewerCount(record.viewerCount) : current.viewerCount,
    viewerCountCheckedAt: normalizeViewerCount(record.viewerCount) !== null ? record.capturedAt || nowIso : current.viewerCountCheckedAt,
    previewImageDataUrl: record.previewImageDataUrl,
    previewCapturedAt: record.capturedAt || nowIso,
    recentCategories: mergeRecentCategories(current.recentCategories, record, record.capturedAt || nowIso),
    recentTags: mergeRecentTags(current.recentTags, record, record.capturedAt || nowIso)
  }, {});

  await writeHistory(history);
}

async function mergeCapturedProfile(record) {
  if (!record || !record.channelKey || !/^[a-z0-9_]{3,25}$/.test(record.channelKey)) {
    return;
  }

  if (!isSafeRemoteImageUrl(record.profileImageUrl)) {
    return;
  }

  const nowIso = new Date().toISOString();
  const history = await readHistory();
  const current = history[record.channelKey] || {
    channelName: record.channelName || record.channelKey,
    displayName: record.displayName || record.channelName || record.channelKey,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    totalWatchSeconds: 0,
    sessionCount: 0,
    lastUrl: record.url || "",
    pageTitle: record.pageTitle || "",
    lastStreamTitle: normalizeStreamTitle(record.lastStreamTitle),
    isLive: record.liveStatusKnown ? record.isLive === true : false,
    liveStatusCheckedAt: record.liveStatusKnown ? nowIso : "",
    viewerCount: normalizeViewerCount(record.viewerCount),
    viewerCountCheckedAt: normalizeViewerCount(record.viewerCount) !== null ? nowIso : "",
    profileImageUrl: "",
    profileCapturedAt: "",
    bannerImageUrl: "",
    imagesVerifiedAt: "",
    previewImageDataUrl: "",
    previewCapturedAt: "",
    recentCategories: [],
    recentTags: []
  };
  const canOverwriteProfile = !current.profileImageUrl || record.reason === "enter";

  history[record.channelKey] = mergeDefined({
    ...current,
    channelName: record.channelName || current.channelName,
    displayName: record.displayName || current.displayName,
    lastSeenAt: record.capturedAt || nowIso,
    lastUrl: record.url || current.lastUrl,
    pageTitle: record.pageTitle || current.pageTitle || "",
    lastStreamTitle: normalizeStreamTitle(record.lastStreamTitle) || current.lastStreamTitle || "",
    isLive: record.liveStatusKnown ? record.isLive === true : current.isLive,
    liveStatusCheckedAt: record.liveStatusKnown ? record.capturedAt || nowIso : current.liveStatusCheckedAt,
    viewerCount: normalizeViewerCount(record.viewerCount) !== null ? normalizeViewerCount(record.viewerCount) : current.viewerCount,
    viewerCountCheckedAt: normalizeViewerCount(record.viewerCount) !== null ? record.capturedAt || nowIso : current.viewerCountCheckedAt,
    profileImageUrl: canOverwriteProfile ? record.profileImageUrl : current.profileImageUrl,
    profileCapturedAt: canOverwriteProfile ? record.capturedAt || nowIso : current.profileCapturedAt,
    imagesVerifiedAt: canOverwriteProfile ? record.capturedAt || nowIso : current.imagesVerifiedAt,
    recentCategories: mergeRecentCategories(current.recentCategories, record, record.capturedAt || nowIso),
    recentTags: mergeRecentTags(current.recentTags, record, record.capturedAt || nowIso)
  }, {});

  await writeHistory(history);
}

async function connectTwitchOAuth(clientId) {
  const cleanClientId = String(clientId || DEFAULT_TWITCH_CLIENT_ID).trim();
  if (!/^[a-z0-9]{20,40}$/i.test(cleanClientId)) {
    throw new Error("Bitte eine gültige Twitch Client-ID eintragen.");
  }

  const state = randomState();
  const redirectUri = getRedirectUrl();
  const params = new URLSearchParams({
    response_type: "token",
    client_id: cleanClientId,
    redirect_uri: redirectUri,
    scope: "",
    state
  });
  const authUrl = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  const redirectResult = await launchWebAuthFlow({ url: authUrl, interactive: true });
  const fragment = new URL(redirectResult).hash.replace(/^#/, "");
  const tokenParams = new URLSearchParams(fragment);

  if (tokenParams.get("state") !== state) {
    throw new Error("OAuth-State stimmt nicht überein.");
  }

  const accessToken = tokenParams.get("access_token") || "";
  if (!accessToken) {
    throw new Error("Twitch hat keinen Access Token zurückgegeben.");
  }

  const expiresIn = Number(tokenParams.get("expires_in") || 0);
  const now = Date.now();
  const auth = {
    clientId: cleanClientId,
    accessToken,
    connectedAt: new Date(now).toISOString(),
    expiresAt: expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : ""
  };
  await writeTwitchAuth(auth);
  return auth;
}

async function getTwitchAuthStatus() {
  const auth = await readTwitchAuth();
  return {
    connected: Boolean(auth.clientId && auth.accessToken),
    clientId: auth.clientId || DEFAULT_TWITCH_CLIENT_ID,
    hasDefaultClientId: true,
    redirectUrl: getRedirectUrl(),
    expiresAt: auth.expiresAt || ""
  };
}

async function fetchTwitchHelix(path, params) {
  const auth = await readTwitchAuth();
  if (!auth.clientId || !auth.accessToken) {
    throw new Error("Twitch OAuth ist noch nicht verbunden.");
  }

  const response = await fetch(`https://api.twitch.tv/helix/${path}?${params.toString()}`, {
    headers: {
      "Client-Id": auth.clientId,
      "Authorization": `Bearer ${auth.accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Twitch API Fehler ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.data) ? payload.data : [];
}

async function fetchTwitchStreams(logins) {
  const params = new URLSearchParams();
  for (const login of logins) {
    params.append("user_login", login);
  }

  return fetchTwitchHelix("streams", params);
}

async function fetchTwitchUsers(logins) {
  const params = new URLSearchParams();
  for (const login of logins) {
    params.append("login", login);
  }

  return fetchTwitchHelix("users", params);
}

async function syncLiveStatusFromApi() {
  const nowIso = new Date().toISOString();
  const history = await readHistory();
  const entries = Object.entries(history)
    .filter(([, item]) => item && (item.channelName || item.displayName))
    .slice(0, 100);
  const logins = entries.map(([, item]) => String(item.channelName || item.displayName).toLowerCase());

  if (logins.length === 0) {
    return { checked: 0, live: 0 };
  }

  const [streams, users] = await Promise.all([
    fetchTwitchStreams(logins),
    fetchTwitchUsers(logins)
  ]);
  const liveByLogin = new Map(streams.map((stream) => [String(stream.user_login || "").toLowerCase(), stream]));
  const userByLogin = new Map(users.map((user) => [String(user.login || "").toLowerCase(), user]));

  for (const [key, item] of entries) {
    const login = String(item.channelName || item.displayName).toLowerCase();
    const stream = liveByLogin.get(login);
    const user = userByLogin.get(login);
    const profileImageUrl = user && isSafeRemoteImageUrl(user.profile_image_url) ? user.profile_image_url : "";
    const displayName = (stream && stream.user_name) || (user && user.display_name) || item.displayName;

    if (stream) {
      history[key] = mergeDefined({
        ...item,
        displayName,
        lastStreamTitle: normalizeStreamTitle(stream.title) || item.lastStreamTitle || "",
        isLive: true,
        liveStatusCheckedAt: nowIso,
        viewerCount: Number(stream.viewer_count || 0),
        viewerCountCheckedAt: nowIso,
        profileImageUrl: profileImageUrl || item.profileImageUrl,
        profileCapturedAt: profileImageUrl ? nowIso : item.profileCapturedAt,
        imagesVerifiedAt: profileImageUrl ? nowIso : item.imagesVerifiedAt,
        recentCategories: mergeRecentCategories(item.recentCategories, {
          categoryName: stream.game_name,
          categoryUrl: stream.game_name ? `https://www.twitch.tv/directory/category/${encodeURIComponent(stream.game_name.toLowerCase().replace(/\s+/g, "-"))}` : ""
        }, nowIso),
        recentTags: mergeRecentTags(item.recentTags, { tags: Array.isArray(stream.tags) ? stream.tags : [] }, nowIso),
        bannerImageUrl: stream.thumbnail_url ? stream.thumbnail_url.replace("{width}", "640").replace("{height}", "360") : item.bannerImageUrl
      }, {});
    } else {
      history[key] = mergeDefined({
        ...item,
        displayName,
        isLive: false,
        liveStatusCheckedAt: nowIso,
        viewerCount: 0,
        viewerCountCheckedAt: nowIso,
        profileImageUrl: profileImageUrl || item.profileImageUrl,
        profileCapturedAt: profileImageUrl ? nowIso : item.profileCapturedAt,
        imagesVerifiedAt: profileImageUrl ? nowIso : item.imagesVerifiedAt
      }, {});
    }
  }

  await writeHistory(history);
  return { checked: logins.length, live: streams.length, profiles: users.length };
}

async function markObservedFollowingChannels(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }

  const nowIso = new Date().toISOString();
  const history = await readHistory();
  for (const record of records) {
    if (!record || !record.channelKey || !/^[a-z0-9_]{3,25}$/.test(record.channelKey)) {
      continue;
    }

    const current = history[record.channelKey];
    if (!current) {
      continue;
    }

    history[record.channelKey] = {
      ...current,
      isFollowing: true,
      followingCheckedAt: nowIso
    };
  }

  await writeHistory(history);
  await storageSet({ [FOLLOWING_CHECKED_AT_KEY]: nowIso });
}

async function mergeChannelMetadata(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }

  const history = await readHistory();
  for (const record of records) {
    if (!record || !record.channelKey || !/^[a-z0-9_]{3,25}$/.test(record.channelKey)) {
      continue;
    }

    const current = history[record.channelKey];
    if (!current) {
      continue;
    }

    history[record.channelKey] = mergeDefined(current, {
      channelName: record.channelName || current.channelName,
      displayName: record.displayName || current.displayName,
      lastStreamTitle: normalizeStreamTitle(record.lastStreamTitle) || current.lastStreamTitle,
      isLive: record.liveStatusKnown ? record.isLive === true : current.isLive,
      liveStatusCheckedAt: record.liveStatusKnown ? new Date().toISOString() : current.liveStatusCheckedAt,
      viewerCount: normalizeViewerCount(record.viewerCount) !== null ? normalizeViewerCount(record.viewerCount) : current.viewerCount,
      viewerCountCheckedAt: normalizeViewerCount(record.viewerCount) !== null ? new Date().toISOString() : current.viewerCountCheckedAt,
      recentTags: mergeRecentTags(current.recentTags, record, new Date().toISOString()),
      profileImageUrl: record.imagesVerified ? record.profileImageUrl : current.profileImageUrl,
      bannerImageUrl: record.imagesVerified ? record.bannerImageUrl : current.bannerImageUrl,
      imagesVerifiedAt: record.imagesVerified ? new Date().toISOString() : current.imagesVerifiedAt
    });
  }

  await writeHistory(history);
}

async function isTabWatchable(tabId, state) {
  const tab = await getTab(tabId);
  if (!tab || !tab.active || !state.channelName) {
    return false;
  }

  const windowInfo = await getWindow(tab.windowId);
  if (!windowInfo || !windowInfo.focused) {
    return false;
  }

  const parsed = parseTwitchChannelUrl(tab.url || state.url);
  return Boolean(parsed && parsed.key === state.channelKey);
}

async function beginWatch(tabId, state) {
  if (state.watchStartedAt) {
    return;
  }

  const visitAlreadyCounted = await hasVisitBeenCounted(state.visitId);
  const shouldCountSession = state.countSession !== false && !visitAlreadyCounted;
  state.watchStartedAt = Date.now();
  state.lastHeartbeatAt = Date.now();

  await updateChannelRecord(state, {
    addSession: shouldCountSession
  });

  if (shouldCountSession) {
    await markVisitCounted(state.visitId);
  }

  trackedTabs.set(tabId, state);
}

async function flushWatch(tabId, options = {}) {
  const state = trackedTabs.get(tabId);
  if (!state || !state.watchStartedAt) {
    return;
  }

  const now = Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((now - state.watchStartedAt) / 1000));
  if (elapsedSeconds > 0) {
    await updateChannelRecord(state, {
      addSeconds: elapsedSeconds,
      lastSeenAt: new Date(now).toISOString()
    });
  }

  state.watchStartedAt = options.continueWatching ? now : null;
  state.lastHeartbeatAt = now;
  trackedTabs.set(tabId, state);
}

async function reconcileTab(tabId, options = {}) {
  const state = trackedTabs.get(tabId);
  if (!state) {
    return;
  }

  const watchable = await isTabWatchable(tabId, state);
  if (watchable) {
    await beginWatch(tabId, state);
    if (options.flushActive) {
      await flushWatch(tabId, { continueWatching: true });
    }
    return;
  }

  await flushWatch(tabId);
}

async function setTabRoute(tabId, route) {
  const parsed = parseTwitchChannelUrl(route.url);
  const previous = trackedTabs.get(tabId);

  if (previous && previous.watchStartedAt) {
    await flushWatch(tabId);
  }

  if (!parsed) {
    trackedTabs.set(tabId, {
      tabId,
      url: route.url || "",
      pageTitle: route.pageTitle || "",
      displayName: route.displayName || "",
      lastStreamTitle: normalizeStreamTitle(route.lastStreamTitle),
      isLive: route.liveStatusKnown ? route.isLive === true : false,
      liveStatusKnown: route.liveStatusKnown === true,
      viewerCount: normalizeViewerCount(route.viewerCount),
      tags: Array.isArray(route.tags) ? route.tags : [],
      profileImageUrl: route.profileImageUrl || "",
      bannerImageUrl: route.bannerImageUrl || "",
      imagesVerified: route.imagesVerified === true,
      categoryName: route.categoryName || "",
      categoryUrl: route.categoryUrl || "",
      channelName: null,
      channelKey: null,
      visitId: route.visitId || "",
      countSession: route.countSession !== false,
      watchStartedAt: null,
      lastHeartbeatAt: Date.now()
    });
    return;
  }

  trackedTabs.set(tabId, {
    tabId,
    url: route.url,
    pageTitle: route.pageTitle || "",
    displayName: route.displayName || parsed.channelName,
    lastStreamTitle: normalizeStreamTitle(route.lastStreamTitle),
    isLive: route.liveStatusKnown ? route.isLive === true : false,
    liveStatusKnown: route.liveStatusKnown === true,
    viewerCount: normalizeViewerCount(route.viewerCount),
    tags: Array.isArray(route.tags) ? route.tags : [],
    profileImageUrl: route.profileImageUrl || "",
    bannerImageUrl: route.bannerImageUrl || "",
    imagesVerified: route.imagesVerified === true,
    categoryName: route.categoryName || "",
    categoryUrl: route.categoryUrl || "",
    channelName: parsed.channelName,
    channelKey: parsed.key,
    visitId: route.visitId || `${tabId}:${parsed.key}:${Date.now()}`,
    countSession: route.countSession !== false,
    watchStartedAt: null,
    lastHeartbeatAt: Date.now()
  });

  await reconcileTab(tabId);
}

async function flushAllActive(options = {}) {
  const tabIds = Array.from(trackedTabs.keys());
  for (const tabId of tabIds) {
    const state = trackedTabs.get(tabId);
    if (state && state.watchStartedAt) {
      await flushWatch(tabId, options);
    }
  }
}

async function getHistoryList() {
  await flushAllActive({ continueWatching: true });
  const history = await readHistory();
  return Object.values(history);
}

async function clearHistory() {
  await storageSet({ [HISTORY_KEY]: {} });
  await sessionSet({ [COUNTED_VISITS_KEY]: {} });

  for (const [tabId, state] of trackedTabs.entries()) {
    trackedTabs.set(tabId, {
      ...state,
      watchStartedAt: null
    });
    await reconcileTab(tabId);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const windowInfo = await getLastFocusedWindow();
  focusedWindowId = windowInfo ? windowInfo.id : null;
});

chrome.runtime.onStartup.addListener(async () => {
  const windowInfo = await getLastFocusedWindow();
  focusedWindowId = windowInfo ? windowInfo.id : null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  (async () => {
    if (message.type === "TWH_ROUTE" && tabId !== null) {
      await setTabRoute(tabId, {
        url: message.url,
        pageTitle: message.pageTitle,
        displayName: message.displayName,
        lastStreamTitle: message.lastStreamTitle,
        isLive: message.isLive,
        liveStatusKnown: message.liveStatusKnown,
        viewerCount: message.viewerCount,
        tags: message.tags,
        profileImageUrl: message.profileImageUrl,
        bannerImageUrl: message.bannerImageUrl,
        imagesVerified: message.imagesVerified,
        categoryName: message.categoryName,
        categoryUrl: message.categoryUrl,
        visitId: message.visitId
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_HEARTBEAT" && tabId !== null) {
      const state = trackedTabs.get(tabId);
      const parsed = parseTwitchChannelUrl(message.url);
      const needsRouteRefresh =
        !state ||
        state.url !== message.url ||
        state.visitId !== message.visitId ||
        (parsed && state.channelKey !== parsed.key);

      if (needsRouteRefresh) {
        await setTabRoute(tabId, {
          url: message.url,
          pageTitle: message.pageTitle,
          displayName: message.displayName,
          lastStreamTitle: message.lastStreamTitle,
          isLive: message.isLive,
          liveStatusKnown: message.liveStatusKnown,
          viewerCount: message.viewerCount,
          tags: message.tags,
          profileImageUrl: message.profileImageUrl,
          bannerImageUrl: message.bannerImageUrl,
          imagesVerified: message.imagesVerified,
          categoryName: message.categoryName,
          categoryUrl: message.categoryUrl,
          visitId: message.visitId
        });
      } else {
        state.pageTitle = message.pageTitle || state.pageTitle || "";
        state.displayName = message.displayName || state.displayName || "";
        state.lastStreamTitle = normalizeStreamTitle(message.lastStreamTitle) || state.lastStreamTitle || "";
        if (message.liveStatusKnown === true) {
          state.isLive = message.isLive === true;
          state.liveStatusKnown = true;
        }
        if (normalizeViewerCount(message.viewerCount) !== null) {
          state.viewerCount = normalizeViewerCount(message.viewerCount);
        }
        state.tags = Array.isArray(message.tags) ? message.tags : state.tags || [];
        state.categoryName = message.categoryName || state.categoryName || "";
        state.categoryUrl = message.categoryUrl || state.categoryUrl || "";
        if (message.imagesVerified === true) {
          state.profileImageUrl = message.profileImageUrl || state.profileImageUrl || "";
          state.bannerImageUrl = message.bannerImageUrl || state.bannerImageUrl || "";
          state.imagesVerified = true;
        }
        state.lastHeartbeatAt = Date.now();
        trackedTabs.set(tabId, state);
        await reconcileTab(tabId, { flushActive: true });
      }

      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_CHANNEL_METADATA") {
      await mergeChannelMetadata(message.records);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_FOLLOWING_VISIBLE") {
      await markObservedFollowingChannels(message.records);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_PREVIEW_CAPTURED") {
      await mergeCapturedPreview({
        channelKey: message.channelKey,
        channelName: message.channelName,
        displayName: message.displayName,
        lastStreamTitle: message.lastStreamTitle,
        isLive: message.isLive,
        liveStatusKnown: message.liveStatusKnown,
        viewerCount: message.viewerCount,
        tags: message.tags,
        url: message.url,
        pageTitle: message.pageTitle,
        previewImageDataUrl: message.previewImageDataUrl,
        capturedAt: message.capturedAt,
        categoryName: message.categoryName,
        categoryUrl: message.categoryUrl
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_PROFILE_CAPTURED") {
      await mergeCapturedProfile({
        channelKey: message.channelKey,
        channelName: message.channelName,
        displayName: message.displayName,
        lastStreamTitle: message.lastStreamTitle,
        isLive: message.isLive,
        liveStatusKnown: message.liveStatusKnown,
        viewerCount: message.viewerCount,
        tags: message.tags,
        url: message.url,
        pageTitle: message.pageTitle,
        profileImageUrl: message.profileImageUrl,
        capturedAt: message.capturedAt,
        categoryName: message.categoryName,
        categoryUrl: message.categoryUrl,
        reason: message.reason
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_GET_AUTH_STATUS") {
      const status = await getTwitchAuthStatus();
      sendResponse({ ok: true, status });
      return;
    }

    if (message.type === "TWH_CONNECT_TWITCH") {
      try {
        const auth = await connectTwitchOAuth(message.clientId);
        sendResponse({ ok: true, status: {
          connected: true,
          clientId: auth.clientId,
          redirectUrl: getRedirectUrl(),
          expiresAt: auth.expiresAt || ""
        } });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === "TWH_DISCONNECT_TWITCH") {
      await writeTwitchAuth({});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TWH_SYNC_LIVE_STATUS") {
      try {
        const result = await syncLiveStatusFromApi();
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === "TWH_GET_HISTORY") {
      const items = await getHistoryList();
      sendResponse({ ok: true, items });
      return;
    }

    if (message.type === "TWH_CLEAR_HISTORY") {
      await clearHistory();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })();

  return true;
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await flushAllActive();
  await reconcileTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    await setTabRoute(tabId, {
      url: changeInfo.url,
      pageTitle: tab.title || "",
      visitId: `${tabId}:${Date.now()}`,
      countSession: false
    });
    return;
  }

  if (changeInfo.title) {
    const state = trackedTabs.get(tabId);
    if (state) {
      state.pageTitle = changeInfo.title;
      trackedTabs.set(tabId, state);
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await flushWatch(tabId);
  trackedTabs.delete(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  focusedWindowId = windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId;
  await flushAllActive();

  if (focusedWindowId !== null) {
    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, windowId: focusedWindowId }, resolve);
    });
    if (tabs[0]) {
      await reconcileTab(tabs[0].id);
    }
  }
});

setInterval(async () => {
  const now = Date.now();
  for (const [tabId, state] of trackedTabs.entries()) {
    if (state.watchStartedAt && now - state.lastHeartbeatAt > HEARTBEAT_STALE_MS) {
      await flushWatch(tabId);
    }
  }
}, HEARTBEAT_STALE_MS);
