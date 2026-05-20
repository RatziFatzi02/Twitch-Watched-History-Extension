const HISTORY_KEY = "twhHistory";
const COUNTED_VISITS_KEY = "twhCountedVisits";
const HEARTBEAT_STALE_MS = 20000;

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

function mergeRecentCategories(existingCategories, state, nowIso) {
  const existing = Array.isArray(existingCategories) ? existingCategories : [];
  const categoryName = normalizeCategoryName(state.categoryName);
  if (!categoryName) {
    return existing.slice(0, 3);
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

  return next.slice(0, 3);
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
    profileImageUrl: state.profileImageUrl || "",
    bannerImageUrl: state.bannerImageUrl || "",
    imagesVerifiedAt: state.imagesVerified ? nowIso : "",
    recentCategories: []
  };

  history[state.channelKey] = mergeDefined({
    ...current,
    channelName: state.channelName,
    displayName: state.displayName || current.displayName || state.channelName,
    lastSeenAt: patch.lastSeenAt || nowIso,
    totalWatchSeconds: Math.max(0, current.totalWatchSeconds + (patch.addSeconds || 0)),
    sessionCount: current.sessionCount + (patch.addSession ? 1 : 0),
    lastUrl: state.url || current.lastUrl,
    pageTitle: state.pageTitle || current.pageTitle || "",
    recentCategories: mergeRecentCategories(current.recentCategories, state, nowIso)
  }, {
    profileImageUrl: state.profileImageUrl || current.profileImageUrl,
    bannerImageUrl: state.bannerImageUrl || current.bannerImageUrl,
    imagesVerifiedAt: state.imagesVerified ? nowIso : current.imagesVerifiedAt
  });

  await writeHistory(history);
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
