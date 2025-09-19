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

    // Debug: preview the first 500 characters
    console.log('\n=== HTML Preview ===');
    console.log(text.substring(0, 500));
    console.log('=== End Preview ===\n');

    return text;
  } catch (err) {
    console.log('❌ Error fetching Yad2:', err);
    throw err;
  }
};

// ================================
// Scrape Items (image + ad URL)
// ================================
const scrapeItemsAndExtractImgUrls = async (url) => {
  const yad2Html = await getYad2Response(url);
  if (!yad2Html) throw new Error('Could not get Yad2 response');

  const $ = cheerio.load(yad2Html);
  const titleText = $('title').first().text();

  if (titleText === 'ShieldSquare Captcha') {
    throw new Error('Bot detection triggered!');
  }

  // Select all ad images
  const $feedItems = $('img[data-nagish="feed-item-image"]');

  console.log(`Found ${$feedItems.length} feed images`);

  if ($feedItems.length === 0) {
    throw new Error('Could not find feed items on the page');
  }

  const items = [];
  $feedItems.each((_, elm) => {
    const imgSrc = $(elm).attr('src')?.trim();
    const parentLink = $(elm).closest('a').attr('href');
    const fullLink = parentLink ? new URL(parentLink, 'https://www.yad2.co.il').href : null;

    if (imgSrc && fullLink) {
      items.push({ image: imgSrc, link: fullLink });
    }
  });

  console.log('Extracted items:', items);
  return items;
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

// ================================
// Check for New Items
// ================================
const checkIfHasNewItem = async (items, topic) => {
  const filePath = `./data/${topic}.json`;
  let savedLinks = readJsonArray(filePath);

  const newItems = [];
  for (const item of items) {
    if (item.link && !savedLinks.includes(item.link)) {
      savedLinks.push(item.link);
      newItems.push(item);
    }
  }

  if (newItems.length > 0) {
    writeJson(filePath, savedLinks);
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
const MAX_CHARS = 3900; // stay safely below Telegram's ~4096 limit

function shortenLink(u) {
  try {
    const url = new URL(u);
    // Drop query to keep it short but clickable
    return url.origin + url.pathname;
  } catch {
    return String(u).split('?')[0];
  }
}

/**
 * Split a list of lines into chunks whose full message length (header + lines)
 * stays within MAX_CHARS. Keeps whole lines; never splits inside a line.
 */
function chunkLinesByChars(lines, baseHeader, maxChars = MAX_CHARS) {
  const chunks = [];
  let curr = [];
  let currLen = baseHeader.length + 2; // header + \n\n

  for (const line of lines) {
    const lineLen = line.length + 1; // + newline
    // leave room (≈40 chars) for " (part X/Y)" suffix we add later
    const reserve = 40;
    if (currLen + lineLen > (maxChars - reserve)) {
      if (curr.length === 0) {
        // single super-long line; hard truncate to fit
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

  // Keep messages short: only show the ad link (drop the image URL)
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
const scrape = async (topic, url) => {
  const apiToken = process.env.API_TOKEN || config.telegramApiToken;
  const chatId = process.env.CHAT_ID || config.chatId;
  const telenode = new Telenode({ apiToken });

  try {
    await safeSend(telenode, chatId, `Starting scanning ${topic} on link:\n${url}`);

    const scrapeImgResults = await scrapeItemsAndExtractImgUrls(url);
    const newItems = await checkIfHasNewItem(scrapeImgResults, topic);

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
  await Promise.all(
    (config.projects || [])
      .filter((project) => {
        if (project.disabled) console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        return !project.disabled;
      })
      .map((project) => scrape(project.topic, project.url))
  );
};

program().catch((e) => {
  console.error('Fatal error from program():', e);
  process.exitCode = 1;
});
