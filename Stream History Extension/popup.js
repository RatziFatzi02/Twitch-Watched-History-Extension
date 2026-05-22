const summary = document.getElementById("summary");
const refreshButton = document.getElementById("refresh");
const clearButton = document.getElementById("clear");
const authStatus = document.getElementById("auth-status");
const redirectUrl = document.getElementById("redirect-url");
const connectButton = document.getElementById("connect-twitch");
const syncLiveButton = document.getElementById("sync-live");

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

async function loadSummary() {
  const response = await sendMessage({ type: "TWH_GET_HISTORY" });
  const items = response && response.ok ? response.items : [];
  const totalSeconds = items.reduce((sum, item) => sum + (item.totalWatchSeconds || 0), 0);
  summary.textContent = `${items.length} Kanäle, ${formatWatchTime(totalSeconds)} Watchtime`;
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

refreshButton.addEventListener("click", loadSummary);

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  connectButton.textContent = "Verbinde...";
  const response = await sendMessage({ type: "TWH_CONNECT_TWITCH" });
  if (!response || !response.ok) {
    window.alert(response && response.error ? response.error : "Twitch OAuth konnte nicht verbunden werden.");
  }
  connectButton.disabled = false;
  await loadAuthStatus();
});

syncLiveButton.addEventListener("click", async () => {
  syncLiveButton.disabled = true;
  syncLiveButton.textContent = "Prüfe...";
  const response = await sendMessage({ type: "TWH_SYNC_LIVE_STATUS" });
  if (!response || !response.ok) {
    window.alert(response && response.error ? response.error : "Live-Status konnte nicht geprüft werden.");
  } else {
    await loadSummary();
  }
  syncLiveButton.disabled = false;
  syncLiveButton.textContent = "Live-Status per API prüfen";
});

clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Lokale Twitch-History wirklich löschen?");
  if (!confirmed) {
    return;
  }
  await sendMessage({ type: "TWH_CLEAR_HISTORY" });
  await loadSummary();
});

loadSummary();
loadAuthStatus();
