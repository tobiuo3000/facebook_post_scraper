; (function () {
  // ─── Custom Error Class ──────────────────────────────────────────────────────
  class CrawlerError extends Error {
    constructor(message, { element = null, context = {} } = {}) {
      super(message);
      this.name = "CrawlerError";
      this.element = element;
      this.context = context;
      this.timestamp = new Date().toISOString();
    }
  }

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
    if (!postEl || !postEl.closest) {
      throw new CrawlerError("Invalid post element provided", { element: postEl });
    }

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
        throw new CrawlerError("Failed to parse data-ft attribute", {
          element: ftEl,
          context: { error: e.message }
        });
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
    try {
      if (!document || !document.querySelectorAll) {
        throw new CrawlerError('Document not ready for querying', {
          context: { documentReadyState: document?.readyState }
        });
      }

      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      console.log(`[FB Crawler] found ${articles.length} elements with role="article"`);

      return Array.from(document.querySelectorAll('[role="article"]'))
        .filter(article => {
          try {
            return article.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
          } catch (e) {
            throw new CrawlerError('Failed to query article links', {
              element: article,
              context: { error: e.message }
            });
          }
        })
        .map(article => {
          let candidates;
          try {
            candidates = Array.from(article.querySelectorAll("div[dir='auto']"))
              .filter(el => el.innerText.trim().length > 0);
          } catch (e) {
            throw new CrawlerError('Failed to query content elements', {
              element: article,
              context: { error: e.message }
            });
          }

          if (candidates.length === 0) {
            console.warn('[FB Crawler] No valid content elements found in article', article);
            return null;
          }

          let best = candidates[0];
          for (const el of candidates) {
            try {
              if (el.innerText.trim().length > best.innerText.trim().length) {
                best = el;
              }
            } catch (e) {
              console.warn('[FB Crawler] Failed to compare content elements', {
                error: e.message,
                element: el
              });
              continue;
            }
          }
          return { postEl: article, contentEl: best };
        })
        .filter(x => x !== null);
    } catch (error) {
      console.error('[FB Crawler] getMessageEls failed:', error);
      if (error instanceof CrawlerError) throw error;
      throw new CrawlerError('Unexpected error in getMessageEls', {
        context: { error: error.message }
      });
    }
  }

  async function scrollUntilNewPosts(prevCount, timeout = 50000) {
    try {
      if (typeof prevCount !== 'number' || prevCount < 0) {
        throw new CrawlerError('Invalid prevCount parameter', {
          context: { prevCount }
        });
      }
      if (typeof timeout !== 'number' || timeout <= 0) {
        throw new CrawlerError('Invalid timeout parameter', {
          context: { timeout }
        });
      }

      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
        } catch (e) {
          throw new CrawlerError('Scroll operation failed', {
            context: { error: e.message }
          });
        }

        await sleep(800 + Math.random() * 400);
        
        let count;
        try {
          count = getMessageEls().length;
        } catch (e) {
          console.error('[FB Crawler] Failed to get message count:', e);
          continue; // Try again on next iteration
        }

        if (count > prevCount) return count;
      }
      return prevCount;
    } catch (error) {
      console.error('[FB Crawler] scrollUntilNewPosts failed:', error);
      if (error instanceof CrawlerError) throw error;
      throw new CrawlerError('Unexpected error in scrollUntilNewPosts', {
        context: { error: error.message }
      });
    }
  }

  // call this before you read contentEl.innerText
  async function expandPostContent(_postEl, contentEl) {
    if (!contentEl || !(contentEl instanceof HTMLElement)) {
      throw new CrawlerError('Invalid content element provided', {
        element: contentEl,
        function: 'expandPostContent'
      });
    }

    // these are the labels we care about:
    const EXPAND_TEXTS = ["See more", "もっと見る", "さらに表示", "続きを読む"];
    let found;
    let attempts = 0;
    const MAX_ATTEMPTS = 5;

    try {
      // keep looking for a button inside this post's content
      do {
        found = false;
        attempts++;
        
        const buttons = contentEl.querySelectorAll("span, div, a");
        if (!buttons.length) {
          throw new CrawlerError('No expandable elements found', {
            element: contentEl,
            attempts
          });
        }

        for (const btn of buttons) {
          try {
            const txt = btn.innerText.trim();
            if (EXPAND_TEXTS.includes(txt)) {
              simulateClick(btn);
              await sleep(300 + Math.random() * 200);
              found = true;
              break;  // restart the inner loop to catch nested expansions
            }
          } catch (err) {
            console.error('Failed to expand post content element', {
              error: err,
              element: btn,
              post: _postEl
            });
          }
        }
        
        if (attempts >= MAX_ATTEMPTS) {
          throw new CrawlerError('Max expansion attempts reached', {
            element: contentEl,
            attempts
          });
        }
      } while (found);
      
      return true;
    } catch (err) {
      console.error('Failed to expand post content', {
        error: err,
        post: _postEl,
        content: contentEl
      });
      return false;
    }
  }


  // ─── Main Crawler ─────────────────────────────────────────────────────────────
  async function startFBPostCrawling() {
    console.log("[FB Crawler] startFBPostCrawling()");
    let initial;
    try {
      initial = getMessageEls().length;
      if (initial === 0) {
        console.warn("[FB Crawler] no articles found—check your selector or page type.");
      }
    } catch (e) {
      console.error("[FB Crawler] Failed to get initial posts:", e);
      throw new CrawlerError("Initial post collection failed", {
        context: { error: e.message }
      });
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