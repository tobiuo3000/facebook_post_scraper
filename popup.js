document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");

  // popup.js
  async function sendToContent(action) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url.match(/^https?:\/\/([^\/]+\.)?facebook\.com/)) {
      alert("Switch to a Facebook page and try again.");
      statusEl.textContent = "Status: Idle";
      return false;
    }

    // 1) check our init flag in the page
    const [{ result: already }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.fbCrawlerInitialized === true
    });

    // 2) if not yet injected, inject utils.js + content.js
    if (!already) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["utils.js", "content.js"]
        });
      } catch (e) {
        console.error("Injection failed:", e);
        alert("Failed to inject content script.");
        statusEl.textContent = "Status: Idle";
        return false;
      }
    }

    // 3) now send the message
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { action }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error("Message failed:", err.message || err);
          alert("Unable to communicate with the content script.");
          statusEl.textContent = "Status: Idle";
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }



  startBtn.addEventListener("click", async () => {
    statusEl.textContent = "Status: Crawling…";
    const ok = await sendToContent("start");
    if (!ok) statusEl.textContent = "Status: Idle";
  });

  stopBtn.addEventListener("click", async () => {
    statusEl.textContent = "Status: Stopping…";
    const ok = await sendToContent("stop");
    statusEl.textContent = ok ? "Status: Stopped" : "Status: Idle";
  });
});
