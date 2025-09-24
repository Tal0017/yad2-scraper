// index.js
// If you're on Node <18, uncomment the next two lines:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
// globalThis.fetch = globalThis.fetch || fetch;

const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// ================================
// Rate-limit-safe Telegram sender
// ================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeSend(telenode, chatId, text, { maxRetries = 5 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await telenode.sendTextMessage(text, chatId);
    } catch (e) {
      const status = e?.response?.status || e?.status;
      const retryAfterParam = e?.response?.data?.parameters?.retry_after;
      const retryAfterHeader = e?.response?.headers?.['retry-after'];
      const retryAfterSec = Number(retryAfterParam || retryAfterHeader);

      if (status === 429 && attempt < maxRetries) {
        const waitMs = Number.isFinite(retryAfterSec)
          ? retryAfterSec * 1000
          : (1000 * Math.pow(2, attempt));
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw e;
    }
  }
}

// ================================
/** Basic logging helpers */
function info(...a) { console.log('[INFO]', ...a); }
function warn(...a) { console.warn('[WARN]', ...a); }

// ================================
// Fetch Yad2 Page
// ================================
const getYad2Response = async (url) => {
  const requestOptions = {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/100.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
  try {
    const res = await fetch(url, requestOptions);
    const text = await res.text();

    // Debug (short)
    info('Fetched HTML length:', text.length);
    return text;
  } catch (err) {
    console.log('❌ Error fetching Yad2:', err);
    throw err;
  }
};

// ================================
// JSON helpers (avoid require() cache)
// ================================
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}
function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error(`Failed reading JSON from ${filePath}`, e);
    return [];
  }
}
function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
function fileExists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

// ================================
// URL helpers
// ================================
/** Extract stable Yad2 item ID from URL path: .../item/XXXXX */
function getItemId(u) {
  try {
    const { pathname } = new URL(u);
    const m = pathname.match(/\/item\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Shorten for display (drop query) */
function shortenLink(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return String(u).split('?')[0];
  }
}

/**
 * Build a page URL using a "page" query param (1-based).
 * If page === 1, return base as-is.
 */
function buildPageUrl(baseUrl, page) {
  if (page <= 1) return baseUrl;
  try {
    const u = new URL(baseUrl);
    // common param name is often "page"
    u.searchParams.set('page', String(page));
    return u.toString();
  } catch {
    // If baseUrl is not absolute, try to prefix
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${page}`;
  }
}

// Try to detect a "next" link in the DOM (best-effort)
function detectNextPageUrl($, currentUrl) {
  // rel="next"
  let href = $('a[rel="next"]').attr('href');
  if (!href) {
    // common "Next" patterns (Hebrew "הבא")
    href = $('a:contains("Next"), a:contains("הבא"), a.pagination__next, a.page-link.next').attr('href');
  }
  if (!href) return null;
  try {
    return new URL(href, currentUrl).toString();
  } catch {
    return null;
  }
}

// ================================
// Scrape Items (image + ad URL) from ONE page
// ================================
async function scrapeItemsFromSinglePage(url) {
  const yad2Html = await getYad2Response(url);
  if (!yad2Html) throw new Error('Could not get Yad2 response');

  const $ = cheerio.load(yad2Html);
  const titleText = $('title').first().text();
  if (titleText === 'ShieldSquare Captcha') {
    throw new Error('Bot detection triggered!');
  }

  // Select all ad images; anchor parent should hold the ad link
  const $feedItems = $('img[data-nagish="feed-item-image"]');
  info(`Found ${$feedItems.length} feed images on ${shortenLink(url)}`);

  const items = [];
  $feedItems.each((_, elm) => {
    const imgSrc = $(elm).attr('src')?.trim();
    const parentLink = $(elm).closest('a').attr('href');
    const fullLink = parentLink ? new URL(parentLink, 'https://www.yad2.co.il').href : null;
    if (imgSrc && fullLink) {
      items.push({ image: imgSrc, link: fullLink });
    }
  });

  // Deduplicate within this page by ID
  const seenRun = new Set();
  const uniqueItems = [];
  for (const it of items) {
    const id = getItemId(it.link);
    if (!id) continue;
    if (seenRun.has(id)) continue;
    seenRun.add(id);
    uniqueItems.push(it);
  }

  const nextUrl = detectNextPageUrl($, url); // may be null
  return { items: uniqueItems, nextUrl };
}

// ================================
// Collect multiple pages per topic
// ================================
async function collectItemsAcrossPages(baseUrl, maxPages) {
  const aggregated = [];
  const seenIds = new Set();

  let pageUrl = baseUrl;
  let usedDetectedNext = false;

  for (let p = 1; p <= maxPages; p++) {
    // Build page URL if we are not following detected next links
    const targetUrl = usedDetectedNext ? pageUrl : buildPageUrl(baseUrl, p);

    try {
      const { items, nextUrl } = await scrapeItemsFromSinglePage(targetUrl);

      // Aggregate with run-level dedupe by ID
      for (const it of items) {
        const id = getItemId(it.link);
        if (!id) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        aggregated.push(it);
      }

      // Prefer detected next if available (some sites need it); switch into "follow-next" mode
      if (nextUrl && p < maxPages) {
        pageUrl = nextUrl;
        usedDetectedNext = true;
      } else if (usedDetectedNext && !nextUrl) {
        // We were following "next" but there's no more
        break;
      }
    } catch (e) {
      warn(`Page ${p} failed: ${e?.message || e}`);
      // Continue to next page try (sometimes randomization or throttling fails)
      continue;
    }
  }

  info(`Collected ${aggregated.length} unique items across up to ${maxPages} pages`);
  return aggregated;
}

// ================================
// Check for New Items (ID-based, multi-page aware)
// ================================
const checkIfHasNewItem = async (items, topic, { bootstrapIfEmpty = true } = {}) => {
  const filePath = `./data/${topic}_ids.json`;

  const existedBefore = fileExists(filePath);
  const prev = readJsonArray(filePath);

  // Migrate: if we detect URLs, convert them to IDs; otherwise assume IDs already
  const migrated = prev.map(v => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
      const id = getItemId(v);
      return id || v;
    }
    return v;
  });

  const knownIds = new Set(migrated.filter(Boolean).map(String));

  // Build encountered IDs & new items list
  const newItems = [];
  for (const item of items) {
    const id = getItemId(item.link);
    if (!id) continue;
    if (!knownIds.has(id)) {
      newItems.push(item);
    }
  }

  // If bootstrap mode and no previous history, save but don't send
  if ((!existedBefore || knownIds.size === 0) && bootstrapIfEmpty) {
    const allIds = new Set();
    for (const it of items) {
      const id = getItemId(it.link);
      if (id) allIds.add(id);
    }
    writeJson(filePath, Array.from(allIds).slice(-10000)); // keep 10k
    info(`Bootstrap: saved ${allIds.size} IDs for topic "${topic}", sending 0.`);
    return [];
  }

  // Merge newly encountered IDs into known and persist
  if (items.length > 0) {
    for (const it of items) {
      const id = getItemId(it.link);
      if (id) knownIds.add(id);
    }
    writeJson(filePath, Array.from(knownIds).slice(-10000)); // keep 10k
  }

  if (newItems.length > 0) {
    createPushFlagForWorkflow();
  }

  return newItems;
};

// ================================
// Create Push Flag
// ================================
const createPushFlagForWorkflow = () => {
  fs.writeFileSync('push_me', '');
};

// ================================
// Telegram-safe batching by characters
// ================================
const MAX_CHARS = 3900;

function chunkLinesByChars(lines, baseHeader, maxChars = MAX_CHARS) {
  const chunks = [];
  let curr = [];
  let currLen = baseHeader.length + 2; // header + \n\n

  for (const line of lines) {
    const lineLen = line.length + 1; // + newline
    const reserve = 40; // leave room for "(part X/Y)"
    if (currLen + lineLen > (maxChars - reserve)) {
      if (curr.length === 0) {
        const truncated = line.slice(0, maxChars - baseHeader.length - reserve - 10) + '…';
        chunks.push([truncated]);
        curr = [];
        currLen = baseHeader.length + 2;
      } else {
        chunks.push(curr);
        curr = [line];
        currLen = baseHeader.length + 2 + lineLen;
      }
    } else {
      curr.push(line);
      currLen += lineLen;
    }
  }
  if (curr.length) chunks.push(curr);
  return chunks;
}

async function notifyNewItems(telenode, chatId, newItems) {
  if (!newItems || newItems.length === 0) return;

  const lines = newItems.map(it => `• ${shortenLink(it.link)}`);

  const baseHeader = `🆕 New items found (${newItems.length})`;
  const groups = chunkLinesByChars(lines, baseHeader, MAX_CHARS);

  for (let i = 0; i < groups.length; i++) {
    const partTag = groups.length > 1 ? ` (part ${i + 1}/${groups.length})` : '';
    const text = `${baseHeader}${partTag}\n\n${groups[i].join('\n')}`;
    await safeSend(telenode, chatId, text);
  }
}

// ================================
// Main Scrape Workflow
// ================================
const scrape = async (topic, url, pagesToScan, bootstrapIfEmpty = true) => {
  const apiToken = process.env.API_TOKEN || config.telegramApiToken;
  const chatId = process.env.CHAT_ID || config.chatId;
  const telenode = new Telenode({ apiToken });

  try {
    await safeSend(telenode, chatId, `Scanning **${topic}** across up to ${pagesToScan} page(s):\n${url}`);

    const allItems = await collectItemsAcrossPages(url, pagesToScan);
    const newItems = await checkIfHasNewItem(allItems, topic, { bootstrapIfEmpty });

    if (newItems.length > 0) {
      await notifyNewItems(telenode, chatId, newItems);
    } else {
      await safeSend(telenode, chatId, 'No new items were added');
    }
  } catch (e) {
    const errMsg = e?.message ? `Error: ${e.message}` : 'Unknown error';
    try {
      await safeSend(telenode, chatId, `Scan workflow failed... 😥\n${errMsg}`);
    } catch {}
    throw e;
  }
};

// ================================
// Entry Point
// ================================
const program = async () => {
  const defaultPages = Number(config.defaultPages) || 3;
  const bootstrapIfEmpty = config.bootstrapIfEmpty !== false; // default true

  await Promise.all(
    (config.projects || [])
      .filter((project) => {
        if (project.disabled) info(`Topic "${project.topic}" is disabled. Skipping.`);
        return !project.disabled;
      })
      .map((project) => {
        const pages = Number(project.pages) || defaultPages;
        return scrape(project.topic, project.url, pages, bootstrapIfEmpty);
      })
  );
};

program().catch((e) => {
  console.error('Fatal error from program():', e);
  process.exitCode = 1;
});
