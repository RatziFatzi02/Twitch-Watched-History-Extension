const summary = document.getElementById("summary");
const refreshButton = document.getElementById("refresh");
const clearButton = document.getElementById("clear");

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
  summary.textContent = `${items.length} Kanaele, ${formatWatchTime(totalSeconds)} Watchtime`;
}

refreshButton.addEventListener("click", loadSummary);
clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Lokale Twitch-History wirklich loeschen?");
  if (!confirmed) {
    return;
  }
  await sendMessage({ type: "TWH_CLEAR_HISTORY" });
  await loadSummary();
});

loadSummary();
