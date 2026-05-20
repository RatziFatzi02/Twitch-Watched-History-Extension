(() => {
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

  let currentChannelKey = null;
  let currentVisitId = createVisitId();
  let historyPanel = null;
  let historyTab = null;
  let tabHost = null;
  let isHistoryOpen = false;
  let observerStarted = false;
  let metadataTimer = null;
  let sidebarOffsetTimer = null;

  function createVisitId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function parseTwitchChannelUrl(urlValue) {
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

  function getNormalizedPath() {
    const path = window.location.pathname.replace(/\/+$/, "");
    return path || "/";
  }

  function isFollowingPage() {
    return getNormalizedPath() === "/directory/following" || getNormalizedPath().startsWith("/directory/following/");
  }

  function isHistoryPage() {
    return getNormalizedPath() === "/directory/following/history";
  }

  function getMetaContent(selector) {
    const node = document.querySelector(selector);
    return node ? node.getAttribute("content") || "" : "";
  }

  function isValidChannelName(value) {
    return /^[a-zA-Z0-9_]{3,25}$/.test(String(value || "").trim());
  }

  function parseChannelHref(href) {
    try {
      const url = new URL(href, window.location.origin);
      const parsed = parseTwitchChannelUrl(url.href);
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function normalizeImageUrl(value) {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
      return "";
    }

    try {
      const url = new URL(value, window.location.origin);
      if (url.protocol !== "https:") {
        return "";
      }
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function extractBackgroundImageUrl(node) {
    const backgroundImage = window.getComputedStyle(node).backgroundImage;
    const match = backgroundImage && backgroundImage.match(/url\(["']?(.+?)["']?\)/);
    return match ? normalizeImageUrl(match[1]) : "";
  }

  function findPageDisplayName(parsed) {
    if (!parsed) {
      return "";
    }

    const candidates = [
      getMetaContent('meta[property="og:title"]'),
      getMetaContent('meta[name="twitter:title"]'),
      document.title.replace(/\s+-\s+Twitch.*$/i, ""),
      ...Array.from(document.querySelectorAll("h1")).map((node) => node.textContent.trim())
    ];

    return candidates.find((candidate) => {
      const clean = String(candidate || "").trim();
      return isValidChannelName(clean) && clean.toLowerCase() === parsed.key;
    }) || parsed.channelName;
  }

  function findCurrentCategory() {
    const main = document.querySelector("main") || document.body;
    const links = Array.from(main.querySelectorAll('a[href*="/directory/category/"]'))
      .filter((link) => !link.closest("#twh-history-panel"))
      .map((link) => {
        const rect = link.getBoundingClientRect();
        const text = link.textContent.replace(/\s+/g, " ").trim();
        return {
          link,
          rect,
          text
        };
      })
      .filter((candidate) => {
        const style = window.getComputedStyle(candidate.link);
        return (
          candidate.text.length > 0 &&
          candidate.text.length <= 80 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          candidate.rect.width > 20 &&
          candidate.rect.height > 8 &&
          candidate.rect.top >= 45
        );
      })
      .sort((a, b) => {
        const aScore = Math.abs(a.rect.left - 360) + Math.abs(a.rect.top - 620);
        const bScore = Math.abs(b.rect.left - 360) + Math.abs(b.rect.top - 620);
        return aScore - bScore;
      });

    if (!links[0]) {
      return {};
    }

    return {
      categoryName: links[0].text,
      categoryUrl: new URL(links[0].link.getAttribute("href") || links[0].link.href, window.location.origin).href
    };
  }

  function collectImagesFromNode(root) {
    const candidates = [];
    const nodes = [root, ...Array.from(root.querySelectorAll("img")).slice(0, 24)];

    for (const node of nodes) {
      if (node instanceof HTMLImageElement) {
        const src = normalizeImageUrl(node.currentSrc || node.src);
        if (!src) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        candidates.push({
          src,
          width: rect.width || node.naturalWidth || 0,
          height: rect.height || node.naturalHeight || 0
        });
      }

      const backgroundSrc = extractBackgroundImageUrl(node);
      if (backgroundSrc) {
        const rect = node.getBoundingClientRect();
        candidates.push({
          src: backgroundSrc,
          width: rect.width || 0,
          height: rect.height || 0
        });
      }
    }

    return candidates;
  }

  function pickProfileImage(images) {
    const squareImages = images
      .filter((image) => image.width > 24 && image.height > 24)
      .filter((image) => Math.abs(image.width - image.height) <= Math.max(12, image.width * 0.25))
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    return squareImages[0] ? squareImages[0].src : "";
  }

  function pickBannerImage(images, profileImageUrl) {
    const wideImages = images
      .filter((image) => image.src !== profileImageUrl)
      .filter((image) => image.width >= 120 && image.height >= 60)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));

    return wideImages[0] ? wideImages[0].src : "";
  }

  function collectCurrentChannelMetadata(parsed) {
    if (!parsed) {
      return {};
    }

    const category = findCurrentCategory();
    return {
      displayName: findPageDisplayName(parsed),
      categoryName: category.categoryName,
      categoryUrl: category.categoryUrl
    };
  }

  function getChannelKeysInNode(node) {
    const keys = new Set();
    const links = Array.from(node.querySelectorAll('a[href^="/"], a[href^="https://www.twitch.tv/"]'));
    for (const candidate of links) {
      const parsed = parseChannelHref(candidate.getAttribute("href") || candidate.href);
      if (parsed) {
        keys.add(parsed.key);
      }
    }
    return keys;
  }

  function findCardForChannelLink(link, parsed) {
    let node = link;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const rect = node.getBoundingClientRect();
      const hasImages = node.querySelectorAll("img").length > 0 || extractBackgroundImageUrl(node);
      const channelKeys = getChannelKeysInNode(node);
      const text = node.textContent.toLowerCase();
      const isCardSized = rect.width >= 160 && rect.width <= 620 && rect.height >= 90 && rect.height <= 420;
      const containsOnlyThisChannel = channelKeys.size === 1 && channelKeys.has(parsed.key);
      const containsChannelText = text.includes(parsed.key);

      if (hasImages && isCardSized && containsOnlyThisChannel && containsChannelText) {
        return node;
      }
      node = node.parentElement;
    }

    return null;
  }

  function findDisplayNameInCard(card, parsed) {
    const candidates = Array.from(card.querySelectorAll("a, p, span, h2, h3"))
      .map((node) => node.textContent.trim())
      .filter(Boolean);

    return candidates.find((candidate) => {
      return isValidChannelName(candidate) && candidate.toLowerCase() === parsed.key;
    }) || parsed.channelName;
  }

  function collectFollowingPageMetadata() {
    if (!isFollowingPage()) {
      return;
    }

    const byKey = new Map();
    const links = Array.from(document.querySelectorAll('a[href^="/"], a[href^="https://www.twitch.tv/"]'));

    for (const link of links) {
      const parsed = parseChannelHref(link.getAttribute("href") || link.href);
      if (!parsed || byKey.has(parsed.key)) {
        continue;
      }

      if (link.closest("#twh-history-panel") || link.closest("#twh-history-tab")) {
        continue;
      }

      const card = findCardForChannelLink(link, parsed);
      if (!card) {
        continue;
      }

      const images = collectImagesFromNode(card);
      const profileImageUrl = pickProfileImage(images);
      const bannerImageUrl = pickBannerImage(images, profileImageUrl);

      byKey.set(parsed.key, {
        channelKey: parsed.key,
        channelName: parsed.channelName,
        displayName: findDisplayNameInCard(card, parsed),
        profileImageUrl,
        bannerImageUrl,
        imagesVerified: Boolean(profileImageUrl || bannerImageUrl)
      });
    }

    const records = Array.from(byKey.values()).filter((record) => {
      return record.displayName || record.imagesVerified;
    });

    if (records.length > 0) {
      sendMessage({
        type: "TWH_CHANNEL_METADATA",
        records
      });
    }
  }

  function scheduleMetadataCollection() {
    window.clearTimeout(metadataTimer);
    metadataTimer = window.setTimeout(collectFollowingPageMetadata, 700);
  }

  function sendMessage(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (error) {
      // The extension context can be invalidated during reloads.
    }
  }

  function sendRouteUpdate() {
    const parsed = parseTwitchChannelUrl(window.location.href);
    const metadata = collectCurrentChannelMetadata(parsed);
    const nextChannelKey = parsed ? parsed.key : null;
    if (nextChannelKey !== currentChannelKey) {
      currentVisitId = createVisitId();
      currentChannelKey = nextChannelKey;
    }

    sendMessage({
      type: "TWH_ROUTE",
      url: window.location.href,
      pageTitle: document.title,
      displayName: metadata.displayName,
      profileImageUrl: metadata.profileImageUrl,
      bannerImageUrl: metadata.bannerImageUrl,
      categoryName: metadata.categoryName,
      categoryUrl: metadata.categoryUrl,
      visitId: currentVisitId
    });

    handleFollowingPageState();
    scheduleMetadataCollection();
  }

  function sendHeartbeat() {
    const parsed = parseTwitchChannelUrl(window.location.href);
    const metadata = collectCurrentChannelMetadata(parsed);
    sendMessage({
      type: "TWH_HEARTBEAT",
      url: window.location.href,
      pageTitle: document.title,
      displayName: metadata.displayName,
      profileImageUrl: metadata.profileImageUrl,
      bannerImageUrl: metadata.bannerImageUrl,
      categoryName: metadata.categoryName,
      categoryUrl: metadata.categoryUrl,
      visitId: currentVisitId
    });
  }

  function patchHistoryMethods() {
    if (window.__twhHistoryPatched) {
      return;
    }

    window.__twhHistoryPatched = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event("twh-location-change"));
      return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event("twh-location-change"));
      return result;
    };

    window.addEventListener("popstate", () => {
      window.dispatchEvent(new Event("twh-location-change"));
    });
  }

  function findFollowingTabHost() {
    const links = Array.from(document.querySelectorAll('a[href*="/directory/following"]'));
    const channelsLink = links.find((link) => {
      try {
        const url = new URL(link.href);
        return url.pathname.replace(/\/+$/, "") === "/directory/following/channels";
      } catch (error) {
        return false;
      }
    });

    if (!channelsLink) {
      return null;
    }

    let node = channelsLink.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const followingLinkCount = node.querySelectorAll('a[href*="/directory/following"]').length;
      if (followingLinkCount >= 2) {
        return node;
      }
      node = node.parentElement;
    }

    return channelsLink.parentElement;
  }

  function installHistoryTab() {
    if (!isFollowingPage()) {
      return;
    }

    const host = findFollowingTabHost();
    if (!host) {
      return;
    }

    tabHost = host;

    const existing = document.getElementById("twh-history-tab");
    if (existing && host.contains(existing)) {
      historyTab = existing;
      updateHistoryTabState();
      return;
    }

    if (existing) {
      existing.remove();
    }

    historyTab = document.createElement("button");
    historyTab.id = "twh-history-tab";
    historyTab.type = "button";
    historyTab.className = "twh-history-tab";
    historyTab.textContent = "History";
    historyTab.setAttribute("role", "tab");
    historyTab.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigateToHistoryPage();
    });

    host.appendChild(historyTab);
    updateHistoryTabState();
  }

  function ensureHistoryPanel() {
    if (historyPanel && document.contains(historyPanel)) {
      return historyPanel;
    }

    historyPanel = document.createElement("section");
    historyPanel.id = "twh-history-panel";
    historyPanel.className = "twh-history-panel";
    historyPanel.hidden = true;

    document.body.appendChild(historyPanel);

    return historyPanel;
  }

  function getTwitchSidebarWidth() {
    if (window.innerWidth < 900) {
      return 0;
    }

    const selectors = [
      '[data-a-target="side-nav-bar"]',
      '[data-a-target="side-nav"]',
      '[data-test-selector="side-nav"]',
      'nav[aria-label*="Side"]',
      'aside',
      '[class*="side-nav"]'
    ];

    const candidates = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((node, index, nodes) => nodes.indexOf(node) === index)
      .filter((node) => !node.closest("#twh-history-panel"));

    for (const node of candidates) {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const isVisible = style.display !== "none" && style.visibility !== "hidden";
      const startsAtLeftEdge = rect.left >= -2 && rect.left <= 8;
      const isSidebarSized = rect.width >= 45 && rect.width <= 360 && rect.height >= window.innerHeight * 0.45;

      if (isVisible && startsAtLeftEdge && isSidebarSized) {
        return Math.round(rect.right);
      }
    }

    const pointCandidates = document.elementsFromPoint(12, 80);
    for (const pointNode of pointCandidates) {
      let node = pointNode;
      for (let depth = 0; node && depth < 8; depth += 1) {
        if (!(node instanceof HTMLElement) || node.closest("#twh-history-panel")) {
          node = node.parentElement;
          continue;
        }

        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const isVisible = style.display !== "none" && style.visibility !== "hidden";
        const startsAtLeftEdge = rect.left >= -2 && rect.left <= 8;
        const isSidebarSized = rect.width >= 45 && rect.width <= 360 && rect.height >= window.innerHeight * 0.45;

        if (isVisible && startsAtLeftEdge && isSidebarSized) {
          return Math.round(rect.right);
        }

        node = node.parentElement;
      }
    }

    return 0;
  }

  function updateHistorySidebarOffset() {
    const sidebarWidth = isHistoryPage() ? getTwitchSidebarWidth() : 0;
    document.documentElement.style.setProperty("--twh-sidebar-width", `${sidebarWidth}px`);
  }

  function scheduleSidebarOffsetUpdate() {
    window.clearTimeout(sidebarOffsetTimer);
    sidebarOffsetTimer = window.setTimeout(updateHistorySidebarOffset, 100);
  }

  function setTwitchContentHidden(hidden) {
    document.documentElement.classList.toggle("twh-history-open", hidden);
    scheduleSidebarOffsetUpdate();
  }

  function navigateToHistoryPage() {
    history.pushState(null, "", "/directory/following/history");
  }

  function navigateToChannelsPage() {
    history.pushState(null, "", "/directory/following/channels");
  }

  function updateHistoryTabState() {
    ensureHistoryPanel();

    if (historyTab) {
      historyTab.classList.toggle("twh-history-tab-active", isHistoryPage());
      historyTab.setAttribute("aria-selected", String(isHistoryPage()));
    }
  }

  function openHistoryPanel() {
    if (isHistoryOpen) {
      updateHistoryTabState();
      return;
    }

    isHistoryOpen = true;
    ensureHistoryPanel();
    updateHistoryTabState();
    if (historyPanel) {
      updateHistorySidebarOffset();
      historyPanel.hidden = false;
      setTwitchContentHidden(true);
      renderHistoryPanel();
    }
  }

  function closeHistoryPanel() {
    isHistoryOpen = false;
    if (historyTab) {
      historyTab.classList.remove("twh-history-tab-active");
      historyTab.setAttribute("aria-selected", "false");
    }
    if (historyPanel) {
      historyPanel.hidden = true;
    }
    setTwitchContentHidden(false);
    document.documentElement.style.removeProperty("--twh-sidebar-width");
  }

  function requestHistory() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "TWH_GET_HISTORY" }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          resolve([]);
          return;
        }
        resolve(response.items || []);
      });
    });
  }

  function clearHistory() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "TWH_CLEAR_HISTORY" }, () => resolve());
    });
  }

  function formatWatchTime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(value));
    } catch (error) {
      return value;
    }
  }

  function sortItems(items, sortMode) {
    const sorted = [...items];
    if (sortMode === "watchtime") {
      sorted.sort((a, b) => (b.totalWatchSeconds || 0) - (a.totalWatchSeconds || 0));
      return sorted;
    }

    if (sortMode === "channel") {
      sorted.sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b)));
      return sorted;
    }

    sorted.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
    return sorted;
  }

  function getDisplayName(item) {
    return String(item.displayName || item.channelName || "Unbekannt");
  }

  function getChannelSlug(item) {
    return String(item.channelName || item.displayName || "").trim();
  }

  function getRecentCategories(item) {
    return Array.isArray(item.recentCategories)
      ? item.recentCategories.filter((category) => category && category.name).slice(0, 3)
      : [];
  }

  function getCategoryFilterOptions(items) {
    const byKey = new Map();
    for (const item of items) {
      for (const category of getRecentCategories(item)) {
        const key = category.name.toLowerCase();
        if (!byKey.has(key)) {
          byKey.set(key, category.name);
        }
      }
    }

    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
  }

  async function renderHistoryPanel() {
    if (!historyPanel) {
      return;
    }

    historyPanel.innerHTML = `
      <div class="twh-history-shell">
        <div class="twh-history-header">
          <div>
            <h2>Twitch History</h2>
            <p>Lokal gespeicherte Kanaele, die du ab jetzt besucht hast.</p>
          </div>
          <button class="twh-history-close" type="button">Kanaele</button>
        </div>
        <div class="twh-history-toolbar">
          <input class="twh-history-search" type="search" placeholder="Kanal suchen" autocomplete="off">
          <select class="twh-history-sort" aria-label="Sortierung">
            <option value="recent">Zuletzt gesehen</option>
            <option value="watchtime">Laengste Watchtime</option>
            <option value="channel">Kanalname</option>
          </select>
          <select class="twh-history-category-filter" aria-label="Kategorie">
            <option value="">Alle Kategorien</option>
          </select>
          <button class="twh-history-following-placeholder" type="button" disabled>Nur Following spaeter</button>
          <button class="twh-history-clear" type="button">History loeschen</button>
        </div>
        <div class="twh-history-grid" aria-live="polite"></div>
      </div>
    `;

    const items = await requestHistory();
    const grid = historyPanel.querySelector(".twh-history-grid");
    const searchInput = historyPanel.querySelector(".twh-history-search");
    const sortSelect = historyPanel.querySelector(".twh-history-sort");
    const categorySelect = historyPanel.querySelector(".twh-history-category-filter");
    const closeButton = historyPanel.querySelector(".twh-history-close");
    const clearButton = historyPanel.querySelector(".twh-history-clear");

    categorySelect.innerHTML = [
      '<option value="">Alle Kategorien</option>',
      ...getCategoryFilterOptions(items).map((categoryName) => {
        return `<option value="${escapeHtml(categoryName.toLowerCase())}">${escapeHtml(categoryName)}</option>`;
      })
    ].join("");

    function paint() {
      const query = searchInput.value.trim().toLowerCase();
      const sortMode = sortSelect.value;
      const categoryFilter = categorySelect.value;
      const filtered = sortItems(items, sortMode).filter((item) => {
        const matchesQuery = `${getDisplayName(item)} ${getChannelSlug(item)}`.toLowerCase().includes(query);
        const matchesCategory =
          !categoryFilter ||
          getRecentCategories(item).some((category) => category.name.toLowerCase() === categoryFilter);
        return matchesQuery && matchesCategory;
      });

      if (filtered.length === 0) {
        grid.innerHTML = `
          <div class="twh-history-empty">
            Noch keine History. Oeffne einen Twitch-Kanal und lass den Tab aktiv laufen.
          </div>
        `;
        return;
      }

      grid.innerHTML = filtered
        .map((item) => {
          const displayName = getDisplayName(item);
          const safeDisplayName = escapeHtml(displayName);
          const channelSlug = getChannelSlug(item);
          const channelUrl = `https://www.twitch.tv/${encodeURIComponent(channelSlug)}`;
          const canUseImages = Boolean(item.imagesVerifiedAt);
          const profileImageUrl = canUseImages ? normalizeImageUrl(item.profileImageUrl || "") : "";
          const bannerImageUrl = canUseImages ? normalizeImageUrl(item.bannerImageUrl || "") : "";
          const initials = escapeHtml(displayName.slice(0, 2).toUpperCase());
          const categories = getRecentCategories(item);
          const categoryMarkup = categories.length > 0
            ? `<div class="twh-history-categories">${categories.map((category) => {
                const href = category.url ? normalizeImageUrl(category.url) : "";
                const label = escapeHtml(category.name);
                return href
                  ? `<a class="twh-history-category" href="${escapeHtml(href)}">${label}</a>`
                  : `<span class="twh-history-category">${label}</span>`;
              }).join("")}</div>`
            : "";
          return `
            <article class="twh-history-card">
              <a class="twh-history-media" href="${channelUrl}" aria-label="${safeDisplayName}">
                ${bannerImageUrl
                  ? `<img class="twh-history-banner" src="${escapeHtml(bannerImageUrl)}" alt="">`
                  : `<div class="twh-history-banner twh-history-banner-fallback"></div>`}
                <div class="twh-history-media-shade"></div>
                ${profileImageUrl
                  ? `<img class="twh-history-avatar" src="${escapeHtml(profileImageUrl)}" alt="">`
                  : `<div class="twh-history-avatar twh-history-avatar-fallback">${initials}</div>`}
                <strong>${safeDisplayName}</strong>
              </a>
              <div class="twh-history-card-body">
                <dl>
                  <div>
                    <dt>Watchtime</dt>
                    <dd>${formatWatchTime(item.totalWatchSeconds)}</dd>
                  </div>
                  <div>
                    <dt>Zuletzt</dt>
                    <dd>${escapeHtml(formatDate(item.lastSeenAt))}</dd>
                  </div>
                  <div>
                    <dt>Sessions</dt>
                    <dd>${Number(item.sessionCount || 0)}</dd>
                  </div>
                </dl>
                ${categoryMarkup}
                <a class="twh-history-link" href="${channelUrl}">Kanal</a>
              </div>
            </article>
          `;
        })
        .join("");
    }

    searchInput.addEventListener("input", paint);
    sortSelect.addEventListener("change", paint);
    categorySelect.addEventListener("change", paint);
    closeButton.addEventListener("click", navigateToChannelsPage);
    clearButton.addEventListener("click", async () => {
      const confirmed = window.confirm("Lokale Twitch-History wirklich loeschen?");
      if (!confirmed) {
        return;
      }
      await clearHistory();
      renderHistoryPanel();
    });

    paint();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function handleFollowingPageState() {
    if (!isFollowingPage()) {
      closeHistoryPanel();
      return;
    }

    installHistoryTab();
    updateHistoryTabState();

    if (isHistoryPage()) {
      openHistoryPanel();
      return;
    }

    closeHistoryPanel();
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest('a[href*="/directory/following"]');
    if (link && historyTab && !historyTab.contains(event.target)) {
      closeHistoryPanel();
    }
  });

  window.addEventListener("twh-location-change", () => {
    window.setTimeout(sendRouteUpdate, 150);
  });

  window.addEventListener("pageshow", sendRouteUpdate);
  window.addEventListener("resize", scheduleSidebarOffsetUpdate);
  document.addEventListener("visibilitychange", sendHeartbeat);

  patchHistoryMethods();
  sendRouteUpdate();
  window.setInterval(sendHeartbeat, 5000);

  if (!observerStarted) {
    observerStarted = true;
    const observer = new MutationObserver(() => {
    if (isFollowingPage()) {
      installHistoryTab();
      updateHistoryTabState();
      scheduleSidebarOffsetUpdate();
      if (isHistoryPage()) {
        ensureHistoryPanel();
        if (historyPanel) {
          historyPanel.hidden = false;
          setTwitchContentHidden(true);
          if (!isHistoryOpen) {
            openHistoryPanel();
          }
        }
      } else {
        closeHistoryPanel();
      }
    }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
})();
