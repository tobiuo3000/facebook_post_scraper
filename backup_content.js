; (function () {
  // ─── Init guard ──────────────────────────────────────────────────────────────
  if (window.fbCrawlerInitialized) {
    console.log("[FB Crawler] already initialized, skipping re-init");
    return;
  }
  window.fbCrawlerInitialized = true;
  console.log("[FB Crawler] content.js loaded");

  let crawling = false;
  let scrapedPosts = [];

  // ─── Message Listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "start") startFBPostCrawling();
    else if (msg.action === "stop") stopAndDownloadCSV();

    sendResponse({ ok: true });
    return true;
  });



  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const simulateClick = el => el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
  );

  // ─── Robust Post-ID Extractor ────────────────────────────────────────────────
  function getPostId(postEl) {
    // 1) try the data-ft attribute
    const ftEl = postEl.closest("[data-ft]");
    if (ftEl) {
      try {
        const ft = JSON.parse(ftEl.getAttribute("data-ft"));
        if (ft.top_level_post_id) {
          console.log("[FB Crawler] got id from data-ft:", ft.top_level_post_id);
          return ft.top_level_post_id;
        }
        if (ft.mf_story_key) {
          console.log("[FB Crawler] got id from mf_story_key:", ft.mf_story_key);
          return ft.mf_story_key;
        }
      } catch (e) {
        console.warn("[FB Crawler] data-ft parse failed", e);
      }
    }

    // 2) fallback: look for a link with “/posts/” or “/permalink/”
    const link = postEl.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
    if (link) {
      const m = link.href.match(/\/(?:posts|permalink)\/(\d+)/);
      if (m) {
        console.log("[FB Crawler] got id from href:", m[1]);
        return m[1];
      }
    }

    console.warn("[FB Crawler] no id found for article:", postEl);
    return null;
  }


  console.log("[FB Crawler] content.js loaded");


  function getMessageEls() {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    console.log(`[FB Crawler] found ${articles.length} elements with role="article"`);

    return Array.from(document.querySelectorAll('[role="article"]'))
      .filter(article =>
        article.querySelector("a[href*='/posts/'], a[href*='/permalink/']")
      )
      .map(article => {
        const candidates = Array.from(article.querySelectorAll("div[dir='auto']"))
          .filter(el => el.innerText.trim().length > 0);
        if (candidates.length === 0) return null;
        let best = candidates[0];
        for (const el of candidates) {
          if (el.innerText.trim().length > best.innerText.trim().length) {
            best = el;
          }
        }
        return { postEl: article, contentEl: best };
      })
      .filter(x => x !== null);
  }

  async function scrollUntilNewPosts(prevCount, timeout = 50000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      await sleep(800 + Math.random() * 400);
      const count = getMessageEls().length;
      if (count > prevCount) return count;
    }
    return prevCount;
  }

  // call this before you read contentEl.innerText
  async function expandPostContent(_postEl, contentEl) {
    // these are the labels we care about:
    const EXPAND_TEXTS = ["See more", "もっと見る", "さらに表示", "続きを読む"];
    let found;

    // keep looking for a button inside this post’s content
    do {
      found = false;
      for (const btn of contentEl.querySelectorAll("span, div, a")) {
        const txt = btn.innerText.trim();
        if (EXPAND_TEXTS.includes(txt)) {
          simulateClick(btn);
          await sleep(300 + Math.random() * 200);
          found = true;
          break;  // restart the inner loop to catch nested expansions
        }
      }
    } while (found);
  }


  // ─── Main Crawler ─────────────────────────────────────────────────────────────
  async function startFBPostCrawling() {
    console.log("[FB Crawler] startFBPostCrawling()");
    const initial = getMessageEls().length;
    if (initial === 0) {
      console.warn("[FB Crawler] no articles found—check your selector or page type.");
    }


    // const maxPosts = 10000;     // ← your target
    let noNewTries = 0;        // count consecutive “no new posts” scrolls
    const maxRetries = 20;   // how many times to retry when no new posts


    if (crawling) return;
    crawling = true;
    scrapedPosts = [];



    // inject highlight CSS
    if (!document.getElementById("fb-crawler-style")) {
      const s = document.createElement("style");
      s.id = "fb-crawler-style";
      s.textContent = `
      .fb-crawler-highlight {
        outline: 3px solid red !important;
        transition: outline 0.3s ease-in-out;
      }
    `;
      document.head.appendChild(s);
    }

    console.log("[FB Crawler] Starting…");
    let prevCount = await scrollUntilNewPosts(0, 10000);
    console.log(`[FB Crawler] Initial posts: ${prevCount}`);

    while (crawling) {
      // expand “See more”
      for (const btn of document.querySelectorAll("div[role='button'], span, a")) {
        const t = btn.innerText.trim();
        if (t === "See more" || t === "さらに表示" || t === "... さらに表示") {
          simulateClick(btn);
          await sleep(300 + Math.random() * 300);
        }
      }

      // const items = getMessageEls();

      // only grab articles we haven’t scraped yet
      const items = Array.from(
        document.querySelectorAll('[role="article"]:not([data-crawled])')
      )
      .filter(article =>
        article.querySelector("a[href*='/posts/'], a[href*='/permalink/']")
      )
      .map(article => {
        // same inner logic as getMessageEls()
        const candidates = Array.from(article.querySelectorAll("div[dir='auto']"))
          .filter(el => el.innerText.trim().length > 0);
        if (!candidates.length) return null;
        let best = candidates[0];
        for (const el of candidates) {
          if (el.innerText.trim().length > best.innerText.trim().length) {
            best = el;
          }
        }
        return { postEl: article, contentEl: best };
      }).filter(x => x);

      console.log(`[FB Crawler] Found ${items.length} posts`);

      for (const { postEl, contentEl } of items) {
        const id = getPostId(postEl);
        if (!id || scrapedPosts.some(p => p.id === id)) continue;

        await expandPostContent(postEl, contentEl);

        // highlight
        document.querySelectorAll(".fb-crawler-highlight")
          .forEach(e => e.classList.remove("fb-crawler-highlight"));
        contentEl.classList.add("fb-crawler-highlight");

        // ─── extract text & user ────────────────────────────────────────────────────
        const text = contentEl.innerText.trim();
        const userEl = postEl.querySelector("h2 strong, h3 strong, h4 strong") || {};
        const username = (userEl.innerText || "Unknown")
          .replace(/\n/g, " ")
          .replace(/#/g, "")
          .trim();

        // ─── extract likes ────────────────────────────────────────────────────────────
        // 1) gather all reaction nodes
        const rawEls = Array.from(
          postEl.querySelectorAll(
            '[aria-label*="いいね"], [aria-label*="リアクション"]'
          )
        );
        // 2) pick the one that actually has a digit
        const countEl = rawEls.find(el =>
          /\d/.test(el.getAttribute("aria-label") || "")
        );

        let likes = 0;
        if (countEl) {
          const label = countEl.getAttribute("aria-label");
          console.log("[FB Crawler] raw likes label:", label);
          const m = label.replace(/,/g, "").match(/(\d+)/);
          if (m) likes = parseInt(m[1], 10);
        } else {
          console.warn("[FB Crawler] no like-count element found");
        }

        // ─── extract date ─────────────────────────────────────────────────────────────

        // — extract date —
        let date = "";

        // 1) data-utime → ISO
        const utEl = postEl.querySelector("[data-utime]");
        if (utEl) {
          const ut = utEl.getAttribute("data-utime");
          console.log("[FB Crawler] raw data-utime:", ut);
          date = new Date(parseInt(ut, 10) * 1000).toISOString();
        }
        else {
          // 2) <time> tag
          const timeEl = postEl.querySelector("time");
          if (timeEl) {
            date = timeEl.getAttribute("datetime") || timeEl.innerText;
            console.log("[FB Crawler] got date from <time>:", date);
          }
          else {
            // 3) <abbr title="…">
            const ab = postEl.querySelector("abbr[title]");
            if (ab) {
              date = ab.getAttribute("title");
              console.log("[FB Crawler] got date from <abbr>:", date);
            }
            else {
              // 4) permalink link text fallback
              const linkEl = postEl.querySelector(
                "a[href*='/posts/'], a[href*='/permalink/']"
              );
              if (linkEl) {
                date = linkEl.innerText.trim();
                console.log("[FB Crawler] got date from link text:", date);
              } else {
                console.warn("[FB Crawler] date element not found");
              }
            }
          }
        }

        // ─── push into scrapedPosts ─────────────────────────────────────────────────
        scrapedPosts.push({
          id,
          username,
          likes,
          date,
          content: text.replace(/\n/g, " ").replace(/#/g, "").trim()
        });

        postEl.setAttribute("data-crawled", "true");

        console.log("[FB Crawler] Scraped:", { id, likes, date });


        await sleep(400 + Math.random() * 300);
      }

      console.log(`Total scraped: ${scrapedPosts.length}`);
      const newCount = await scrollUntilNewPosts(items.length, 5000);
      if (newCount === items.length) {
        // nothing new this time
        noNewTries++;
        if (noNewTries < maxRetries) {
          console.warn(
            `[FB Crawler] No new posts (${noNewTries}/${maxRetries}), ` +
            `scrolling up then down and retrying…`
          );
          // scroll up a bit to force FB to load more
          window.scrollBy({ top: -window.innerHeight * 0.5, behavior: "smooth" });
          await sleep(1000);
          // then scroll down again
          window.scrollBy({ top: window.innerHeight * 0.5, behavior: "smooth" });
          await sleep(2000);
          continue;
        } else {
          console.log(`[FB Crawler] No new posts after ${maxRetries} tries—stopping.`);
          break;
        }
      }

      // we got new posts, reset retry counter
      noNewTries = 0;
      prevCount = newCount;
    }
  }

  console.log("[FB Crawler] Finished.");
  stopAndDownloadCSV();


  // ─── Stop & Download ──────────────────────────────────────────────────────────
  function stopAndDownloadCSV() {
    crawling = false;
    if (!scrapedPosts.length) {
      alert("No posts found!");
      return;
    }
    downloadCSV(scrapedPosts);
    console.log("CSV download triggered.");
    // clear so you can run again
    scrapedPosts = [];
  }

})();