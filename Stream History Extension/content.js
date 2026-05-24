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
  const PREVIEW_CAPTURE_DELAY_MS = 5000;
  const PREVIEW_REFRESH_MS = 30 * 60 * 1000;
  const PREVIEW_TAB_SWITCH_MIN_MS = 30000;
  const PREVIEW_CANVAS_WIDTH = 480;
  const PREVIEW_CANVAS_HEIGHT = 270;
  const MAX_PREVIEW_DATA_URL_LENGTH = 220000;
  const LIVE_STATUS_FRESH_MS = 15 * 60 * 1000;
  const HISTORY_LIVE_AUTO_SYNC_MS = 5 * 60 * 1000;

  let currentChannelKey = null;
  let currentVisitId = createVisitId();
  let historyPanel = null;
  let historyTab = null;
  let tabHost = null;
  let isHistoryOpen = false;
  let observerStarted = false;
  let metadataTimer = null;
  let previewCaptureTimer = null;
  let profileCaptureTimer = null;
  let sidebarOffsetTimer = null;
  let lastObservedUrl = window.location.href;
  let lastHistoryLiveAutoSyncAt = 0;
  const lastPreviewCaptureAtByChannel = new Map();
  const lastProfileCaptureAtByChannel = new Map();

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

  function normalizePreviewImageUrl(value) {
    if (typeof value === "string" && /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(value)) {
      return value.length <= MAX_PREVIEW_DATA_URL_LENGTH ? value : "";
    }

    return normalizeImageUrl(value);
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

  function normalizeStreamTitle(value, parsed) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 3) {
      return "";
    }

    if (parsed && clean.toLowerCase() === parsed.key) {
      return "";
    }

    return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
  }

  function findCurrentStreamTitle(parsed) {
    if (!parsed) {
      return "";
    }

    const selectors = [
      '[data-a-target="stream-title"]',
      '[data-test-selector="StreamTitle"]',
      '[data-a-target="preview-card-title-link"]'
    ];
    const candidates = [];

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (node.closest("#twh-history-panel")) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 20 || rect.height <= 8) {
          continue;
        }

        candidates.push(node.getAttribute("title"));
        candidates.push(node.textContent);
      }
    }

    return candidates
      .map((candidate) => normalizeStreamTitle(candidate, parsed))
      .find(Boolean) || "";
  }

  function isVisibleTextNode(node) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function hasVisibleLiveBadge(root) {
    const selectors = [
      '[data-a-target*="live"]',
      '[data-test-selector*="live"]',
      '[aria-label*="LIVE"]',
      '[aria-label*="Live"]'
    ];

    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (!node.closest("#twh-history-panel") && isVisibleTextNode(node)) {
          const label = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.trim();
          if (/\bLIVE\b/i.test(label)) {
            return true;
          }
        }
      }
    }

    return Array.from(root.querySelectorAll("span, p, div"))
      .some((node) => {
        return !node.closest("#twh-history-panel") && isVisibleTextNode(node) && node.textContent.trim().toUpperCase() === "LIVE";
      });
  }

  function findCurrentLiveStatus(parsed) {
    if (!parsed) {
      return { isLive: false, liveStatusKnown: false };
    }

    const main = document.querySelector("main") || document.body;
    if (hasVisibleLiveBadge(main)) {
      return { isLive: true, liveStatusKnown: true };
    }

    const hasStreamMetadata = Boolean(findCurrentStreamTitle(parsed) || findCurrentCategory().categoryName);
    const hasVisibleVideo = Boolean(findVisibleVideoElement());
    const offlineText = Array.from(main.querySelectorAll("p, span, h2, h3"))
      .filter((node) => !node.closest("#twh-history-panel") && isVisibleTextNode(node))
      .map((node) => node.textContent.replace(/\s+/g, " ").trim().toLowerCase())
      .some((text) => {
        return text.includes("offline") || text.includes("ist gerade nicht live") || text.includes("is currently offline");
      });

    if (offlineText) {
      return { isLive: false, liveStatusKnown: true };
    }

    return {
      isLive: hasStreamMetadata && hasVisibleVideo,
      liveStatusKnown: hasStreamMetadata || hasVisibleVideo
    };
  }

  function findStreamTitleInCard(card, parsed) {
    const titleNode = card.querySelector('[data-a-target="preview-card-title-link"], [data-test-selector="StreamTitle"]');
    if (!titleNode) {
      return "";
    }

    return normalizeStreamTitle(titleNode.getAttribute("title") || titleNode.textContent, parsed);
  }

  function getLiveStatusFromCard(card) {
    const isLive = hasVisibleLiveBadge(card) || card.getAttribute("data-ffz-type") === "live";
    const hasStreamCardData = Boolean(
      card.querySelector('[data-a-target="preview-card-title-link"], [data-test-selector="StreamTitle"], [data-a-target="preview-card-game-link"]')
    );
    return {
      isLive,
      liveStatusKnown: isLive || hasStreamCardData
    };
  }

  function findCurrentProfileImageUrl(parsed) {
    if (!parsed) {
      return "";
    }

    const main = document.querySelector("main") || document.body;
    const selectors = [
      '[data-a-target="channel-avatar"] img',
      '[data-a-target="user-avatar"] img',
      '[data-a-target*="avatar"] img',
      '[data-test-selector*="avatar"] img',
      'img[alt]',
      'img'
    ];
    const candidates = [];
    const seen = new Set();
    const displayName = findPageDisplayName(parsed).toLowerCase();

    for (const selector of selectors) {
      for (const image of main.querySelectorAll(selector)) {
        const src = normalizeImageUrl(image.currentSrc || image.src);
        if (!src || seen.has(src) || image.closest("#twh-history-panel")) {
          continue;
        }
        seen.add(src);

        const rect = image.getBoundingClientRect();
        const style = window.getComputedStyle(image);
        const width = rect.width || image.naturalWidth || 0;
        const height = rect.height || image.naturalHeight || 0;
        const isSquare = Math.abs(width - height) <= Math.max(12, width * 0.25);
        const isVisible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          width >= 36 &&
          height >= 36 &&
          rect.bottom > 50 &&
          rect.top < 850;

        if (!isSquare || !isVisible) {
          continue;
        }

        const label = `${image.alt || ""} ${image.title || ""}`.toLowerCase();
        const labelMatches = label.includes(parsed.key) || (displayName && label.includes(displayName));
        const selectorMatches = /avatar/i.test(selector);
        const sizeScore = Math.min(width * height, 20000) / 1000;
        const positionScore = Math.max(0, 600 - Math.abs(rect.top - 420)) / 20;

        candidates.push({
          src,
          score: sizeScore + positionScore + (selectorMatches ? 40 : 0) + (labelMatches ? 60 : 0)
        });
      }
    }

    const metaImage = normalizeImageUrl(getMetaContent('meta[property="og:image"]'));
    if (metaImage && /profile|avatar|user-default-pictures/i.test(metaImage)) {
      candidates.push({
        src: metaImage,
        score: 30
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ? candidates[0].src : "";
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

  function normalizeTagText(value) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 40) {
      return "";
    }
    return clean;
  }

  function collectTagsFromNode(root) {
    const byKey = new Map();
    const tagNodes = Array.from(root.querySelectorAll(
      'a[href*="/directory/all/tags/"], .tw-tag, [aria-label^="Tag,"], [data-a-target]'
    ));

    for (const node of tagNodes) {
      if (node.closest("#twh-history-panel")) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      if ((root === document.body || root === document.querySelector("main")) && rect.top > 900) {
        continue;
      }

      const href = node.getAttribute("href") || "";
      const ariaLabel = node.getAttribute("aria-label") || "";
      const dataTarget = node.getAttribute("data-a-target") || "";
      const rawText = ariaLabel.replace(/^Tag,\s*/i, "") || node.textContent || dataTarget;
      const tagName = normalizeTagText(rawText);
      if (!tagName || isValidChannelName(tagName) || /preview-card|channel-link|image-link|game-link/i.test(dataTarget)) {
        continue;
      }

      if (!href.includes("/directory/all/tags/") && !ariaLabel.toLowerCase().startsWith("tag,")) {
        continue;
      }

      byKey.set(tagName.toLowerCase(), tagName);
    }

    return Array.from(byKey.values()).slice(0, 8);
  }

  function parseViewerCountText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const match = text.match(/([\d.,]+)\s*(k|m|tsd\.?)?\s*(zuschauer|viewer|viewers)/i);
    if (!match) {
      return null;
    }

    const numberValue = Number(match[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(numberValue)) {
      return null;
    }

    const suffix = (match[2] || "").toLowerCase();
    const multiplier = suffix.startsWith("m") ? 1000000 : suffix.startsWith("k") || suffix.startsWith("tsd") ? 1000 : 1;
    return Math.round(numberValue * multiplier);
  }

  function findViewerCountInNode(root) {
    const candidates = Array.from(root.querySelectorAll("span, p, div"))
      .filter((node) => !node.closest("#twh-history-panel"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 10 && rect.height > 8;
      });

    for (const node of candidates) {
      const viewerCount = parseViewerCountText(node.textContent);
      if (viewerCount !== null) {
        return viewerCount;
      }
    }

    return null;
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
    const liveStatus = findCurrentLiveStatus(parsed);
    return {
      displayName: findPageDisplayName(parsed),
      lastStreamTitle: findCurrentStreamTitle(parsed),
      isLive: liveStatus.isLive,
      liveStatusKnown: liveStatus.liveStatusKnown,
      viewerCount: findViewerCountInNode(document.querySelector("main") || document.body),
      tags: collectTagsFromNode(document.querySelector("main") || document.body),
      categoryName: category.categoryName,
      categoryUrl: category.categoryUrl
    };
  }

  function findVisibleVideoElement() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos
      .map((video) => {
        return {
          video,
          rect: video.getBoundingClientRect()
        };
      })
      .filter((candidate) => {
        const style = window.getComputedStyle(candidate.video);
        return (
          candidate.video.readyState >= 2 &&
          candidate.video.videoWidth > 0 &&
          candidate.video.videoHeight > 0 &&
          candidate.rect.width >= 160 &&
          candidate.rect.height >= 90 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          candidate.rect.bottom > 50 &&
          candidate.rect.right > 0
        );
      })
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.video || null;
  }

  function captureVideoFrameDataUrl() {
    const video = findVisibleVideoElement();
    if (!video) {
      return "";
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = PREVIEW_CANVAS_WIDTH;
      canvas.height = PREVIEW_CANVAS_HEIGHT;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        return "";
      }

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const sourceAspect = sourceWidth / sourceHeight;
      const targetAspect = PREVIEW_CANVAS_WIDTH / PREVIEW_CANVAS_HEIGHT;
      let sx = 0;
      let sy = 0;
      let sw = sourceWidth;
      let sh = sourceHeight;

      if (sourceAspect > targetAspect) {
        sw = sourceHeight * targetAspect;
        sx = (sourceWidth - sw) / 2;
      } else if (sourceAspect < targetAspect) {
        sh = sourceWidth / targetAspect;
        sy = (sourceHeight - sh) / 2;
      }

      context.drawImage(video, sx, sy, sw, sh, 0, 0, PREVIEW_CANVAS_WIDTH, PREVIEW_CANVAS_HEIGHT);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.56);
      return dataUrl.length <= MAX_PREVIEW_DATA_URL_LENGTH ? dataUrl : "";
    } catch (error) {
      return "";
    }
  }

  function captureCurrentPreview(reason, options = {}) {
    const parsed = parseTwitchChannelUrl(window.location.href);
    if (!parsed) {
      return false;
    }

    const now = Date.now();
    const lastCaptureAt = lastPreviewCaptureAtByChannel.get(parsed.key) || 0;
    const minimumAge = reason === "periodic" ? PREVIEW_REFRESH_MS : PREVIEW_TAB_SWITCH_MIN_MS;
    if (!options.force && now - lastCaptureAt < minimumAge) {
      return true;
    }

    const previewImageDataUrl = captureVideoFrameDataUrl();
    if (!previewImageDataUrl) {
      return false;
    }

    lastPreviewCaptureAtByChannel.set(parsed.key, now);
    const metadata = collectCurrentChannelMetadata(parsed);
    sendMessage({
      type: "TWH_PREVIEW_CAPTURED",
      channelKey: parsed.key,
      channelName: parsed.channelName,
      displayName: metadata.displayName,
      lastStreamTitle: metadata.lastStreamTitle,
      isLive: metadata.isLive,
      liveStatusKnown: metadata.liveStatusKnown,
      viewerCount: metadata.viewerCount,
      tags: metadata.tags,
      url: window.location.href,
      pageTitle: document.title,
      previewImageDataUrl,
      capturedAt: new Date(now).toISOString(),
      categoryName: metadata.categoryName,
      categoryUrl: metadata.categoryUrl,
      reason
    });
    return true;
  }

  function schedulePreviewCapture(reason, delayMs = PREVIEW_CAPTURE_DELAY_MS, options = {}) {
    window.clearTimeout(previewCaptureTimer);
    const attempt = options.attempt || 1;
    previewCaptureTimer = window.setTimeout(() => {
      const captured = captureCurrentPreview(reason, options);
      if (!captured && attempt < 4 && parseTwitchChannelUrl(window.location.href)) {
        schedulePreviewCapture(reason, 5000, { ...options, attempt: attempt + 1 });
      }
    }, delayMs);
  }

  function maybeCapturePeriodicPreview(parsed) {
    if (!parsed || document.hidden) {
      return;
    }

    const lastCaptureAt = lastPreviewCaptureAtByChannel.get(parsed.key) || 0;
    if (!lastCaptureAt) {
      return;
    }

    if (Date.now() - lastCaptureAt >= PREVIEW_REFRESH_MS) {
      captureCurrentPreview("periodic");
    }
  }

  function captureCurrentProfileImage(reason, options = {}) {
    const parsed = parseTwitchChannelUrl(window.location.href);
    if (!parsed) {
      return false;
    }

    const now = Date.now();
    const lastCaptureAt = lastProfileCaptureAtByChannel.get(parsed.key) || 0;
    const minimumAge = reason === "periodic" ? PREVIEW_REFRESH_MS : PREVIEW_TAB_SWITCH_MIN_MS;
    if (!options.force && now - lastCaptureAt < minimumAge) {
      return true;
    }

    const profileImageUrl = findCurrentProfileImageUrl(parsed);
    if (!profileImageUrl) {
      return false;
    }

    lastProfileCaptureAtByChannel.set(parsed.key, now);
    const metadata = collectCurrentChannelMetadata(parsed);
    sendMessage({
      type: "TWH_PROFILE_CAPTURED",
      channelKey: parsed.key,
      channelName: parsed.channelName,
      displayName: metadata.displayName,
      lastStreamTitle: metadata.lastStreamTitle,
      isLive: metadata.isLive,
      liveStatusKnown: metadata.liveStatusKnown,
      viewerCount: metadata.viewerCount,
      tags: metadata.tags,
      url: window.location.href,
      pageTitle: document.title,
      profileImageUrl,
      capturedAt: new Date(now).toISOString(),
      categoryName: metadata.categoryName,
      categoryUrl: metadata.categoryUrl,
      reason
    });
    return true;
  }

  function scheduleProfileCapture(reason, delayMs = PREVIEW_CAPTURE_DELAY_MS, options = {}) {
    window.clearTimeout(profileCaptureTimer);
    const attempt = options.attempt || 1;
    profileCaptureTimer = window.setTimeout(() => {
      const captured = captureCurrentProfileImage(reason, options);
      if (!captured && attempt < 4 && parseTwitchChannelUrl(window.location.href)) {
        scheduleProfileCapture(reason, 5000, { ...options, attempt: attempt + 1 });
      }
    }, delayMs);
  }

  function maybeCapturePeriodicProfile(parsed) {
    if (!parsed || document.hidden) {
      return;
    }

    const lastCaptureAt = lastProfileCaptureAtByChannel.get(parsed.key) || 0;
    if (!lastCaptureAt) {
      return;
    }

    if (Date.now() - lastCaptureAt >= PREVIEW_REFRESH_MS) {
      captureCurrentProfileImage("periodic");
    }
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
    const previewArticle = link.closest("article");
    if (previewArticle) {
      const channelKeys = getChannelKeysInNode(previewArticle);
      const hasPreviewImage = Boolean(previewArticle.querySelector('a[data-a-target="preview-card-image-link"] img'));
      const hasPreviewAvatar = Boolean(previewArticle.querySelector('a[data-test-selector="preview-card-avatar"] img'));
      if (hasPreviewImage && hasPreviewAvatar && channelKeys.size === 1 && channelKeys.has(parsed.key)) {
        return previewArticle;
      }
    }

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
      const previewImage = card.querySelector('a[data-a-target="preview-card-image-link"] img');
      const previewAvatar = card.querySelector('a[data-test-selector="preview-card-avatar"] img');
      const profileImageUrl = normalizeImageUrl(previewAvatar && (previewAvatar.currentSrc || previewAvatar.src)) || pickProfileImage(images);
      const bannerImageUrl = normalizeImageUrl(previewImage && (previewImage.currentSrc || previewImage.src)) || pickBannerImage(images, profileImageUrl);

      byKey.set(parsed.key, {
        channelKey: parsed.key,
        channelName: parsed.channelName,
        displayName: findDisplayNameInCard(card, parsed),
        lastStreamTitle: findStreamTitleInCard(card, parsed),
        ...getLiveStatusFromCard(card),
        viewerCount: findViewerCountInNode(card),
        tags: collectTagsFromNode(card),
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
      sendMessage({
        type: "TWH_FOLLOWING_VISIBLE",
        records: records.map((record) => ({
          channelKey: record.channelKey
        }))
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
    lastObservedUrl = window.location.href;
    const parsed = parseTwitchChannelUrl(window.location.href);
    const metadata = collectCurrentChannelMetadata(parsed);
    const nextChannelKey = parsed ? parsed.key : null;
    const channelChanged = nextChannelKey !== currentChannelKey;
    if (nextChannelKey !== currentChannelKey) {
      currentVisitId = createVisitId();
      currentChannelKey = nextChannelKey;
    }

    sendMessage({
      type: "TWH_ROUTE",
      url: window.location.href,
      pageTitle: document.title,
      displayName: metadata.displayName,
      lastStreamTitle: metadata.lastStreamTitle,
      isLive: metadata.isLive,
      liveStatusKnown: metadata.liveStatusKnown,
      viewerCount: metadata.viewerCount,
      tags: metadata.tags,
      profileImageUrl: metadata.profileImageUrl,
      bannerImageUrl: metadata.bannerImageUrl,
      categoryName: metadata.categoryName,
      categoryUrl: metadata.categoryUrl,
      visitId: currentVisitId
    });

    handleFollowingPageState();
    scheduleMetadataCollection();
    if (parsed && channelChanged) {
      schedulePreviewCapture("enter", PREVIEW_CAPTURE_DELAY_MS, { force: true });
      scheduleProfileCapture("enter", PREVIEW_CAPTURE_DELAY_MS, { force: true });
    } else if (!parsed) {
      window.clearTimeout(previewCaptureTimer);
      window.clearTimeout(profileCaptureTimer);
    }
  }

  function checkForLocationChange() {
    if (window.location.href === lastObservedUrl) {
      return;
    }

    sendRouteUpdate();
  }

  function sendHeartbeat() {
    const parsed = parseTwitchChannelUrl(window.location.href);
    const metadata = collectCurrentChannelMetadata(parsed);
    sendMessage({
      type: "TWH_HEARTBEAT",
      url: window.location.href,
      pageTitle: document.title,
      displayName: metadata.displayName,
      lastStreamTitle: metadata.lastStreamTitle,
      isLive: metadata.isLive,
      liveStatusKnown: metadata.liveStatusKnown,
      viewerCount: metadata.viewerCount,
      tags: metadata.tags,
      profileImageUrl: metadata.profileImageUrl,
      bannerImageUrl: metadata.bannerImageUrl,
      categoryName: metadata.categoryName,
      categoryUrl: metadata.categoryUrl,
      visitId: currentVisitId
    });
    maybeCapturePeriodicPreview(parsed);
    maybeCapturePeriodicProfile(parsed);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      captureCurrentPreview("tab-hidden");
      captureCurrentProfileImage("tab-hidden");
    } else {
      schedulePreviewCapture("tab-visible", PREVIEW_CAPTURE_DELAY_MS);
      scheduleProfileCapture("tab-visible", PREVIEW_CAPTURE_DELAY_MS);
    }

    sendHeartbeat();
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

  function getHistoryHeaderTabs() {
    return [
      { label: "Übersicht", href: "/directory/following" },
      { label: "Live", href: "/directory/following/live" },
      { label: "Videos", href: "/directory/following/videos" },
      { label: "Kategorien", href: "/directory/following/games" },
      { label: "Kanäle", href: "/directory/following/channels" },
      { label: "History", href: "/directory/following/history", active: true }
    ];
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

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  }

  async function maybeAutoSyncLiveStatus() {
    if (!isHistoryPage()) {
      return;
    }

    const now = Date.now();
    if (now - lastHistoryLiveAutoSyncAt < HISTORY_LIVE_AUTO_SYNC_MS) {
      return;
    }

    lastHistoryLiveAutoSyncAt = now;
    const response = await sendRuntimeMessage({ type: "TWH_SYNC_LIVE_STATUS" });
    if (response && response.ok && isHistoryPage() && historyPanel && !historyPanel.hidden) {
      renderHistoryPanel({ skipAutoSync: true });
    }
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

  function formatViewerCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) {
      return "";
    }

    return new Intl.NumberFormat(undefined, {
      notation: count >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(count);
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

    if (sortMode === "sessions") {
      sorted.sort((a, b) => (b.sessionCount || 0) - (a.sessionCount || 0));
      return sorted;
    }

    if (sortMode === "viewers") {
      sorted.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
      return sorted;
    }

    if (sortMode === "live") {
      sorted.sort((a, b) => Number(b.isLive === true) - Number(a.isLive === true) || new Date(b.liveStatusCheckedAt || 0) - new Date(a.liveStatusCheckedAt || 0));
      return sorted;
    }

    if (sortMode === "title") {
      sorted.sort((a, b) => String(a.lastStreamTitle || "").localeCompare(String(b.lastStreamTitle || "")));
      return sorted;
    }

    if (sortMode === "game") {
      sorted.sort((a, b) => {
        const aGame = getRecentCategories(a)[0]?.name || "";
        const bGame = getRecentCategories(b)[0]?.name || "";
        return aGame.localeCompare(bGame);
      });
      return sorted;
    }

    if (sortMode === "following") {
      sorted.sort((a, b) => Number(b.isFollowing === true) - Number(a.isFollowing === true) || getDisplayName(a).localeCompare(getDisplayName(b)));
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
      ? item.recentCategories.filter((category) => category && category.name).slice(0, 5)
      : [];
  }

  function getRecentTags(item) {
    return Array.isArray(item.recentTags)
      ? item.recentTags.map((tag) => typeof tag === "string" ? { name: tag } : tag).filter((tag) => tag && tag.name).slice(0, 8)
      : [];
  }

  function tokenizeSearchQuery(query) {
    return String(query || "").match(/[a-zäöü_-]+:"[^"]*"|"[^"]+"|\S+/gi) || [];
  }

  function parseSearchQuery(query) {
    const parts = tokenizeSearchQuery(query);
    return parts.map((part) => {
      const raw = part.trim();
      const match = raw.match(/^([a-zäöü_-]+):(?:"([^"]*)"|(.*))$/i);
      if (!match) {
        const clean = raw.replace(/^"|"$/g, "").trim();
        return { field: "any", value: clean.toLowerCase() };
      }
      return {
        field: match[1].toLowerCase(),
        value: String(match[2] ?? match[3] ?? "").trim().toLowerCase()
      };
    }).filter((token) => token.value);
  }

  function getActiveSearchFragment(query) {
    const text = String(query || "");
    const cursor = text.length;
    let inQuote = false;
    let start = 0;

    for (let index = 0; index < cursor; index += 1) {
      const char = text[index];
      if (char === '"') {
        inQuote = !inQuote;
      } else if (!inQuote && /\s/.test(char)) {
        start = index + 1;
      }
    }

    const raw = text.slice(start, cursor);
    const fieldMatch = raw.match(/^([a-zäöü_-]+):(?:"?([^"]*)?)$/i);
    if (fieldMatch) {
      return {
        start,
        raw,
        field: fieldMatch[1].toLowerCase(),
        value: String(fieldMatch[2] || "").toLowerCase()
      };
    }

    return {
      start,
      raw,
      field: "any",
      value: raw.replace(/^"|"$/g, "").toLowerCase()
    };
  }

  function quoteSearchValue(value) {
    const clean = String(value || "").replace(/\s+/g, " ").trim().replaceAll('"', "");
    if (/^[^\s:"]+$/.test(clean)) {
      return clean;
    }
    return `"${clean}"`;
  }

  function makeSearchToken(field, value) {
    if (!field || field === "any") {
      return quoteSearchValue(value);
    }
    return `${field}:${quoteSearchValue(value)}`;
  }

  function replaceActiveSearchFragment(query, suggestion) {
    const fragment = getActiveSearchFragment(query);
    const token = makeSearchToken(suggestion.field, suggestion.value);
    const before = String(query || "").slice(0, fragment.start).trimEnd();
    return `${before ? `${before} ` : ""}${token} `;
  }

  function addSuggestionValue(map, field, label, value, sourceItem) {
    const cleanValue = String(value || "").replace(/\s+/g, " ").trim();
    if (!cleanValue) {
      return;
    }

    const key = `${field}:${cleanValue.toLowerCase()}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.watchSeconds += Number(sourceItem.totalWatchSeconds || 0);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, new Date(sourceItem.lastSeenAt || 0).getTime());
      return;
    }

    map.set(key, {
      field,
      label,
      value: cleanValue,
      count: 1,
      watchSeconds: Number(sourceItem.totalWatchSeconds || 0),
      lastSeenAt: new Date(sourceItem.lastSeenAt || 0).getTime()
    });
  }

  function buildSearchSuggestions(items, query) {
    const fragment = getActiveSearchFragment(query);
    const value = fragment.value.trim();
    if (!value && fragment.field === "any") {
      return [];
    }

    const fieldGroups = {
      title: ["title", "titel", "stream"],
      game: ["game", "games", "spiel", "kategorie", "category"],
      tag: ["tag", "tags"],
      channel: ["channel", "kanal", "name"]
    };
    const fieldLabels = {
      title: "title",
      game: "game",
      tag: "tag",
      channel: "channel"
    };
    const selectedFields = Object.entries(fieldGroups)
      .filter(([, aliases]) => fragment.field === "any" || aliases.includes(fragment.field))
      .map(([field]) => field);
    const suggestions = new Map();

    for (const item of items) {
      if (selectedFields.includes("channel")) {
        addSuggestionValue(suggestions, "channel", "channel", getDisplayName(item), item);
        addSuggestionValue(suggestions, "channel", "channel", getChannelSlug(item), item);
      }
      if (selectedFields.includes("title")) {
        addSuggestionValue(suggestions, "title", "title", item.lastStreamTitle, item);
      }
      if (selectedFields.includes("game")) {
        for (const category of getRecentCategories(item)) {
          addSuggestionValue(suggestions, "game", "game", category.name, item);
        }
      }
      if (selectedFields.includes("tag")) {
        for (const tag of getRecentTags(item)) {
          addSuggestionValue(suggestions, "tag", "tag", tag.name, item);
        }
      }
    }

    return Array.from(suggestions.values())
      .filter((suggestion) => {
        return !value || suggestion.value.toLowerCase().includes(value);
      })
      .sort((a, b) => {
        return b.count - a.count || b.watchSeconds - a.watchSeconds || b.lastSeenAt - a.lastSeenAt || a.value.localeCompare(b.value);
      })
      .slice(0, 8)
      .map((suggestion) => ({
        ...suggestion,
        label: fieldLabels[suggestion.field] || suggestion.label
      }));
  }

  function parseDurationToSeconds(value) {
    const match = String(value || "").match(/^([<>]=?)?(\d+)(s|m|h)?$/i);
    if (!match) {
      return null;
    }
    const multiplier = match[3] === "h" ? 3600 : match[3] === "m" ? 60 : 1;
    return {
      operator: match[1] || ">=",
      seconds: Number(match[2]) * multiplier
    };
  }

  function compareNumber(actual, queryValue) {
    const match = String(queryValue || "").match(/^([<>]=?|=)?(\d+)$/);
    if (!match) {
      return String(actual).includes(String(queryValue || ""));
    }
    const operator = match[1] || "=";
    const expected = Number(match[2]);
    if (operator === ">") return actual > expected;
    if (operator === ">=") return actual >= expected;
    if (operator === "<") return actual < expected;
    if (operator === "<=") return actual <= expected;
    return actual === expected;
  }

  function itemMatchesToken(item, token) {
    const categories = getRecentCategories(item).map((category) => category.name.toLowerCase());
    const tags = getRecentTags(item).map((tag) => tag.name.toLowerCase());
    const haystack = [
      getDisplayName(item),
      getChannelSlug(item),
      item.lastStreamTitle,
      item.pageTitle,
      ...categories,
      ...tags
    ].join(" ").toLowerCase();

    if (token.field === "any") return haystack.includes(token.value);
    if (["title", "titel", "stream"].includes(token.field)) return String(item.lastStreamTitle || "").toLowerCase().includes(token.value);
    if (["game", "games", "spiel", "kategorie", "category"].includes(token.field)) return categories.some((category) => category.includes(token.value));
    if (["tag", "tags"].includes(token.field)) return tags.some((tag) => tag.includes(token.value));
    if (["channel", "kanal", "name"].includes(token.field)) return `${getDisplayName(item)} ${getChannelSlug(item)}`.toLowerCase().includes(token.value);
    if (["session", "sessions", "season", "seasons"].includes(token.field)) return compareNumber(Number(item.sessionCount || 0), token.value);
    if (["watch", "watchtime", "time", "zeit"].includes(token.field)) {
      const queryDuration = parseDurationToSeconds(token.value);
      if (!queryDuration) return false;
      const actual = Number(item.totalWatchSeconds || 0);
      if (queryDuration.operator === ">") return actual > queryDuration.seconds;
      if (queryDuration.operator === ">=") return actual >= queryDuration.seconds;
      if (queryDuration.operator === "<") return actual < queryDuration.seconds;
      if (queryDuration.operator === "<=") return actual <= queryDuration.seconds;
      return actual === queryDuration.seconds;
    }
    if (["after", "since", "von", "ab"].includes(token.field)) return new Date(item.lastSeenAt || 0) >= new Date(token.value);
    if (["before", "until", "bis"].includes(token.field)) return new Date(item.lastSeenAt || 0) <= new Date(token.value);
    if (token.field === "live") return (item.isLive === true) === ["1", "true", "yes", "ja"].includes(token.value);
    if (["following", "isfollowing", "follow"].includes(token.field)) {
      const expected = ["1", "true", "yes", "ja"].includes(token.value);
      return (item.isFollowing === true) === expected;
    }
    return haystack.includes(`${token.field}:${token.value}`) || haystack.includes(token.value);
  }

  function itemMatchesSearch(item, query) {
    const tokens = parseSearchQuery(query);
    return tokens.length === 0 || tokens.every((token) => itemMatchesToken(item, token));
  }
  async function renderHistoryPanel(options = {}) {
    if (!historyPanel) {
      return;
    }

    historyPanel.innerHTML = `
      <div class="twh-history-shell">
        <div class="twh-history-header">
          <h1>Du folgst</h1>
          <nav class="twh-history-tabs" aria-label="Following Tabs">
            ${getHistoryHeaderTabs().map((tab) => {
              return `<a class="twh-history-header-tab${tab.active ? " twh-history-header-tab-active" : ""}" href="${tab.href}"${tab.active ? ' aria-current="page"' : ""}>${tab.label}</a>`;
            }).join("")}
          </nav>
        </div>
        <h2 class="twh-history-section-title">Twitch History</h2>
        <p class="twh-history-description">Lokal gespeicherte Kanäle, die du ab jetzt besucht hast.</p>
        <div class="twh-history-toolbar">
          <div class="twh-history-search-wrap">
            <input class="twh-history-search" type="search" placeholder="Suche: kanal, title:, game:, tag:, sessions:, after:" autocomplete="off" aria-label="History durchsuchen">
            <div class="twh-history-autocomplete" role="listbox" aria-label="Autocomplete" hidden></div>
            <div class="twh-history-suggestions" aria-label="Suchvorschläge">
              <button type="button" data-token="title:">title:</button>
              <button type="button" data-token="game:">game:</button>
              <button type="button" data-token="tag:">tag:</button>
              <button type="button" data-token="sessions:>3">sessions:&gt;3</button>
              <button type="button" data-token="watch:>30m">watch:&gt;30m</button>
              <button type="button" data-token="after:2026-05-20">after:YYYY-MM-DD</button>
              <button type="button" data-token="live:true">live:true</button>
              <button type="button" data-token="following:true">following:true</button>
            </div>
          </div>
          <select class="twh-history-sort" aria-label="Sortierung">
            <option value="recent">Zuletzt gesehen</option>
            <option value="watchtime">Längste Watchtime</option>
            <option value="sessions">Meiste Sessions</option>
            <option value="viewers">Meiste Zuschauer</option>
            <option value="live">Live zuerst</option>
            <option value="following">Following zuerst</option>
            <option value="game">Spiel</option>
            <option value="title">Streamtitel</option>
            <option value="channel">Kanalname</option>
          </select>
        </div>
        <section class="twh-history-section" aria-label="Zuletzt gesehene Kanäle">
          <h3>Zuletzt gesehen</h3>
          <div class="twh-history-grid" aria-live="polite"></div>
        </section>
      </div>
    `;

    const items = await requestHistory();
    const grid = historyPanel.querySelector(".twh-history-grid");
    const searchInput = historyPanel.querySelector(".twh-history-search");
    const autocomplete = historyPanel.querySelector(".twh-history-autocomplete");
    const suggestions = historyPanel.querySelector(".twh-history-suggestions");
    const sortSelect = historyPanel.querySelector(".twh-history-sort");

    function updateAutocomplete() {
      const query = searchInput.value;
      const autocompleteItems = buildSearchSuggestions(items, query);

      if (autocompleteItems.length === 0) {
        autocomplete.hidden = true;
        autocomplete.innerHTML = "";
        return;
      }

      autocomplete.innerHTML = autocompleteItems
        .map((suggestion) => {
          const countLabel = suggestion.count === 1 ? "1 Kanal" : `${suggestion.count} Kanäle`;
          return `
            <button type="button" role="option" data-field="${escapeHtml(suggestion.field)}" data-value="${escapeHtml(suggestion.value)}">
              <span class="twh-history-autocomplete-field">${escapeHtml(suggestion.label)}:</span>
              <span class="twh-history-autocomplete-value">${escapeHtml(suggestion.value)}</span>
              <span class="twh-history-autocomplete-count">${escapeHtml(countLabel)}</span>
            </button>
          `;
        })
        .join("");
      autocomplete.hidden = false;
    }

    function paint() {
      const query = searchInput.value.trim().toLowerCase();
      const sortMode = sortSelect.value;
      const filtered = sortItems(items, sortMode).filter((item) => {
        return itemMatchesSearch(item, query);
      });

      if (filtered.length === 0) {
        grid.innerHTML = `
          <div class="twh-history-empty">
            Noch keine History. Öffne einen Twitch-Kanal und lass den Tab aktiv laufen.
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
          const previewImageDataUrl = normalizePreviewImageUrl(item.previewImageDataUrl || "");
          const canUseImages = Boolean(item.imagesVerifiedAt);
          const profileImageUrl = canUseImages ? normalizeImageUrl(item.profileImageUrl || "") : "";
          const bannerImageUrl = previewImageDataUrl || (canUseImages ? normalizeImageUrl(item.bannerImageUrl || "") : "");
          const initials = escapeHtml(displayName.slice(0, 2).toUpperCase());
          const categories = getRecentCategories(item);
          const tags = getRecentTags(item);
          const latestCategory = categories[0];
          const categoryLabel = latestCategory ? escapeHtml(latestCategory.name) : "Keine Kategorie erkannt";
          const streamTitle = String(item.lastStreamTitle || "").trim();
          const streamTitleMarkup = streamTitle
            ? `<p class="twh-history-stream-title" title="${escapeHtml(streamTitle)}">${escapeHtml(streamTitle)}</p>`
            : "";
          const liveCheckedAt = item.liveStatusCheckedAt ? new Date(item.liveStatusCheckedAt).getTime() : 0;
          const isFreshLive = item.isLive === true && liveCheckedAt > 0 && Date.now() - liveCheckedAt <= LIVE_STATUS_FRESH_MS;
          const liveBadgeMarkup = isFreshLive ? '<span class="twh-history-live-badge">IS NOW LIVE</span>' : "";
          const viewerLabel = formatViewerCount(item.viewerCount);
          const viewerMarkup = viewerLabel ? `<span class="twh-history-viewers">${escapeHtml(viewerLabel)} Zuschauer</span>` : "";
          const sessionLabel = Number(item.sessionCount || 0) === 1 ? "Session" : "Sessions";
          const gameMarkup = categories.length > 1
            ? `<details class="twh-history-games">
                <summary>${categoryLabel}<span aria-hidden="true">▾</span></summary>
                <div class="twh-history-games-popout">
                  ${categories.slice(0, 3).map((category) => {
                    const href = category.url ? normalizeImageUrl(category.url) : "";
                    const label = escapeHtml(category.name);
                    return href
                      ? `<a href="${escapeHtml(href)}">${label}</a>`
                      : `<span>${label}</span>`;
                  }).join("")}
                </div>
              </details>`
            : `<p class="twh-history-category-line">${categoryLabel}</p>`;
          const tagMarkup = tags.length > 0
            ? `<div class="twh-history-tags">${tags.slice(0, 6).map((tag) => {
                return `<span class="twh-history-tag">${escapeHtml(tag.name)}</span>`;
              }).join("")}</div>`
            : "";
          return `
            <article class="twh-history-card">
              <div class="twh-history-thumb">
                <a class="twh-history-media" href="${channelUrl}" aria-label="${safeDisplayName}">
                  ${bannerImageUrl
                    ? `<img class="twh-history-banner" src="${escapeHtml(bannerImageUrl)}" alt="">`
                    : `<div class="twh-history-banner twh-history-banner-fallback"></div>`}
                  <div class="twh-history-media-shade"></div>
                  ${liveBadgeMarkup}
                  <span class="twh-history-stat twh-history-stat-watch">${formatWatchTime(item.totalWatchSeconds)}</span>
                  ${viewerMarkup}
                  <span class="twh-history-stat twh-history-stat-last">${escapeHtml(formatDate(item.lastSeenAt))}</span>
                </a>
              </div>
              <div class="twh-history-card-body">
                ${profileImageUrl
                  ? `<img class="twh-history-avatar" src="${escapeHtml(profileImageUrl)}" alt="">`
                  : `<div class="twh-history-avatar twh-history-avatar-fallback">${initials}</div>`}
                <div class="twh-history-card-meta">
                  <a class="twh-history-title" href="${channelUrl}">${safeDisplayName}</a>
                  ${streamTitleMarkup}
                  ${gameMarkup}
                  <p class="twh-history-small-meta">${Number(item.sessionCount || 0)} ${sessionLabel} · zuletzt ${escapeHtml(formatDate(item.lastSeenAt))}</p>
                  ${tagMarkup}
                </div>
              </div>
            </article>
          `;
        })
        .join("");
    }

    searchInput.addEventListener("input", () => {
      paint();
      updateAutocomplete();
    });
    searchInput.addEventListener("focus", updateAutocomplete);
    searchInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        autocomplete.hidden = true;
      }, 140);
    });
    autocomplete.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    autocomplete.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-field][data-value]");
      if (!button) {
        return;
      }

      searchInput.value = replaceActiveSearchFragment(searchInput.value, {
        field: button.dataset.field,
        value: button.dataset.value
      });
      searchInput.focus();
      const cursorPosition = searchInput.value.length;
      searchInput.setSelectionRange(cursorPosition, cursorPosition);
      autocomplete.hidden = true;
      paint();
    });
    suggestions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-token]");
      if (!button) {
        return;
      }

      const token = button.dataset.token;
      const prefix = searchInput.value.trim();
      searchInput.value = prefix ? `${prefix} ${token}` : token;
      searchInput.focus();
      const cursorPosition = searchInput.value.length;
      searchInput.setSelectionRange(cursorPosition, cursorPosition);
      paint();
      updateAutocomplete();
    });
    sortSelect.addEventListener("change", paint);
    paint();
    if (!options.skipAutoSync) {
      maybeAutoSyncLiveStatus();
    }
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
    const link = event.target.closest && event.target.closest("a[href]");
    if (!link) {
      return;
    }

    if (link.href && !link.href.includes("/directory/following/history")) {
      window.setTimeout(checkForLocationChange, 250);
    }

    if (link.matches('a[href*="/directory/following"]') && historyTab && !historyTab.contains(event.target)) {
      closeHistoryPanel();
    }
  });

  window.addEventListener("twh-location-change", () => {
    window.setTimeout(checkForLocationChange, 150);
  });

  window.addEventListener("pageshow", sendRouteUpdate);
  window.addEventListener("resize", scheduleSidebarOffsetUpdate);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  patchHistoryMethods();
  sendRouteUpdate();
  window.setInterval(sendHeartbeat, 5000);
  window.setInterval(checkForLocationChange, 750);

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
