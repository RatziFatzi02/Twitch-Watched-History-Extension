const statChannels = document.getElementById("stat-channels");
const statWatchtime = document.getElementById("stat-watchtime");
const statSessions = document.getElementById("stat-sessions");
const refreshButton = document.getElementById("refresh");
const clearButton = document.getElementById("clear");
const authStatus = document.getElementById("auth-status");
const redirectUrl = document.getElementById("redirect-url");
const connectButton = document.getElementById("connect-twitch");
const syncLiveButton = document.getElementById("sync-live");
const syncStatus = document.getElementById("sync-status");
const exportHistoryButton = document.getElementById("export-history");
const importHistoryButton = document.getElementById("import-history");
const importHistoryFile = document.getElementById("import-history-file");
const backupStatus = document.getElementById("backup-status");
const autoBackupEnabled = document.getElementById("auto-backup-enabled");
const autoBackupInterval = document.getElementById("auto-backup-interval");
const autoBackupFilename = document.getElementById("auto-backup-filename");
const saveAutoBackupButton = document.getElementById("save-auto-backup");
const runAutoBackupButton = document.getElementById("run-auto-backup");
const autoBackupStatus = document.getElementById("auto-backup-status");
const dangerStatus = document.getElementById("danger-status");
const recentList = document.getElementById("recent-list");
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const DEFAULT_AUTO_BACKUP_FILENAME = "Twitch Watch History Backups/twitch-watch-history-autobackup.json";

function sendMessage(message) {
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

function formatWatchTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
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

function getDisplayName(item) {
  return String(item.displayName || item.channelName || "Unbekannt");
}

function getExportFilename() {
  const date = new Date().toISOString().slice(0, 10);
  return `twitch-watch-history-${date}.json`;
}

function formatAutoBackupStatus(state, settings) {
  if (state && state.lastError) {
    return `Letzter Fehler: ${state.lastError}`;
  }

  if (state && state.lastBackupAt) {
    return `Letztes Backup: ${formatDate(state.lastBackupAt)} nach ${state.lastFilename || settings.filename}.`;
  }

  return settings && settings.enabled
    ? "Auto-Backup ist aktiv. Das erste Backup läuft nach dem gewählten Intervall."
    : "Auto-Backup ist deaktiviert.";
}

function downloadJson(filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function renderRecentItems(items) {
  const recentItems = [...items]
    .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0))
    .slice(0, 6);

  if (recentItems.length === 0) {
    recentList.innerHTML = '<p class="muted">Noch keine History vorhanden.</p>';
    return;
  }

  recentList.innerHTML = recentItems
    .map((item) => {
      return `
        <div class="recent-item">
          <strong title="${escapeHtml(getDisplayName(item))}">${escapeHtml(getDisplayName(item))}</strong>
          <span>${escapeHtml(formatWatchTime(item.totalWatchSeconds))}</span>
          <span>${escapeHtml(formatDate(item.lastSeenAt))}</span>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadSummary() {
  const response = await sendMessage({ type: "TWH_GET_HISTORY" });
  const items = response && response.ok ? response.items : [];
  const totalSeconds = items.reduce((sum, item) => sum + (item.totalWatchSeconds || 0), 0);
  const totalSessions = items.reduce((sum, item) => sum + (item.sessionCount || 0), 0);

  statChannels.textContent = String(items.length);
  statWatchtime.textContent = formatWatchTime(totalSeconds);
  statSessions.textContent = String(totalSessions);
  renderRecentItems(items);
}

async function loadAuthStatus() {
  const response = await sendMessage({ type: "TWH_GET_AUTH_STATUS" });
  if (!response || !response.ok) {
    authStatus.textContent = "OAuth Status konnte nicht geladen werden.";
    return;
  }

  const status = response.status;
  redirectUrl.textContent = status.redirectUrl || "";
  connectButton.classList.toggle("connected", status.connected === true);
  authStatus.textContent = status.connected
    ? `OAuth verbunden${status.expiresAt ? ` bis ${new Date(status.expiresAt).toLocaleString()}` : ""}.`
    : "OAuth nicht verbunden. Client-ID ist bereits in der Extension hinterlegt.";
  connectButton.textContent = status.connected ? "Twitch verbunden" : "Mit Twitch verbinden";
}

async function loadAutoBackupStatus() {
  const response = await sendMessage({ type: "TWH_GET_AUTO_BACKUP_STATUS" });
  if (!response || !response.ok) {
    autoBackupStatus.textContent = "Auto-Backup Status konnte nicht geladen werden.";
    return;
  }

  const settings = response.status.settings || {};
  const state = response.status.state || {};
  autoBackupEnabled.checked = settings.enabled === true;
  autoBackupInterval.value = String(settings.intervalMinutes || 360);
  autoBackupFilename.value = settings.filename || DEFAULT_AUTO_BACKUP_FILENAME;
  autoBackupStatus.textContent = formatAutoBackupStatus(state, settings);
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  await loadSummary();
  await loadAuthStatus();
  await loadAutoBackupStatus();
  refreshButton.disabled = false;
});

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  connectButton.textContent = "Verbinde...";
  const response = await sendMessage({ type: "TWH_CONNECT_TWITCH" });
  if (!response || !response.ok) {
    authStatus.textContent = response && response.error ? response.error : "Twitch OAuth konnte nicht verbunden werden.";
  }
  connectButton.disabled = false;
  await loadAuthStatus();
});

syncLiveButton.addEventListener("click", async () => {
  syncLiveButton.disabled = true;
  syncLiveButton.textContent = "Prüfe...";
  syncStatus.textContent = "Live-Status wird geprüft...";
  const response = await sendMessage({ type: "TWH_SYNC_LIVE_STATUS" });

  if (!response || !response.ok) {
    syncStatus.textContent = response && response.error ? response.error : "Live-Status konnte nicht geprüft werden.";
  } else {
    const result = response.result || {};
    syncStatus.textContent = `${result.checked || 0} Kanäle geprüft, ${result.live || 0} live.`;
    await loadSummary();
  }

  syncLiveButton.disabled = false;
  syncLiveButton.textContent = "Live-Status per API prüfen";
});

exportHistoryButton.addEventListener("click", async () => {
  exportHistoryButton.disabled = true;
  backupStatus.textContent = "Export wird vorbereitet...";

  const response = await sendMessage({ type: "TWH_EXPORT_HISTORY" });
  if (!response || !response.ok) {
    backupStatus.textContent = response && response.error ? response.error : "Export konnte nicht erstellt werden.";
    exportHistoryButton.disabled = false;
    return;
  }

  downloadJson(getExportFilename(), response.exportData);
  backupStatus.textContent = `${response.exportData.itemCount || 0} Kanäle exportiert.`;
  exportHistoryButton.disabled = false;
});

saveAutoBackupButton.addEventListener("click", async () => {
  saveAutoBackupButton.disabled = true;
  autoBackupStatus.textContent = "Auto-Backup wird gespeichert...";

  const response = await sendMessage({
    type: "TWH_SET_AUTO_BACKUP_SETTINGS",
    settings: {
      enabled: autoBackupEnabled.checked,
      intervalMinutes: Number(autoBackupInterval.value),
      filename: autoBackupFilename.value
    }
  });

  if (!response || !response.ok) {
    autoBackupStatus.textContent = response && response.error ? response.error : "Auto-Backup konnte nicht gespeichert werden.";
  } else {
    const settings = response.status.settings || {};
    const state = response.status.state || {};
    autoBackupEnabled.checked = settings.enabled === true;
    autoBackupInterval.value = String(settings.intervalMinutes || 360);
    autoBackupFilename.value = settings.filename || DEFAULT_AUTO_BACKUP_FILENAME;
    autoBackupStatus.textContent = formatAutoBackupStatus(state, settings);
  }

  saveAutoBackupButton.disabled = false;
});

runAutoBackupButton.addEventListener("click", async () => {
  runAutoBackupButton.disabled = true;
  autoBackupStatus.textContent = "Backup wird geschrieben...";

  const response = await sendMessage({ type: "TWH_RUN_AUTO_BACKUP" });
  if (!response || !response.ok) {
    autoBackupStatus.textContent = response && response.error ? response.error : "Backup konnte nicht geschrieben werden.";
  } else {
    autoBackupStatus.textContent = formatAutoBackupStatus(response.result, {
      filename: autoBackupFilename.value
    });
  }

  runAutoBackupButton.disabled = false;
});

importHistoryButton.addEventListener("click", () => {
  importHistoryFile.value = "";
  importHistoryFile.click();
});

importHistoryFile.addEventListener("change", async () => {
  const file = importHistoryFile.files && importHistoryFile.files[0];
  if (!file) {
    return;
  }

  if (file.size > MAX_IMPORT_BYTES) {
    backupStatus.textContent = "Import-Datei ist zu groß.";
    return;
  }

  const confirmed = window.confirm("History importieren? Kanäle mit gleichem Namen werden durch die Import-Datei ersetzt.");
  if (!confirmed) {
    return;
  }

  importHistoryButton.disabled = true;
  backupStatus.textContent = "Import wird gelesen...";

  try {
    const payload = JSON.parse(await file.text());
    const response = await sendMessage({ type: "TWH_IMPORT_HISTORY", payload });

    if (!response || !response.ok) {
      backupStatus.textContent = response && response.error ? response.error : "Import konnte nicht abgeschlossen werden.";
      return;
    }

    backupStatus.textContent = `${response.result.imported} Kanäle importiert, ${response.result.total} gesamt.`;
    await loadSummary();
  } catch (error) {
    backupStatus.textContent = "Import-Datei ist kein gültiges JSON.";
  } finally {
    importHistoryButton.disabled = false;
  }
});

clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Lokale Twitch-History wirklich löschen?");
  if (!confirmed) {
    return;
  }

  clearButton.disabled = true;
  dangerStatus.textContent = "History wird gelöscht...";
  const response = await sendMessage({ type: "TWH_CLEAR_HISTORY" });
  dangerStatus.textContent = response && response.ok ? "History gelöscht." : "History konnte nicht gelöscht werden.";
  clearButton.disabled = false;
  await loadSummary();
});

loadSummary();
loadAuthStatus();
loadAutoBackupStatus();
