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
          : (1000 * Math.pow(2, attempt)); // fallback exponential backoff
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw e; // preserve original error when not 429 or retries exhausted
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

    // Find the closest parent <a> to get the ad URL
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
// Notification helpers (batch + limit-safe)
// ================================
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function notifyNewItems(telenode, chatId, newItems) {
  if (!newItems || newItems.length === 0) return;

  // Build lines like: "• URL — IMG"
  const lines = newItems.map((it) => `• ${it.link} — ${it.image}`);
  const header = `🆕 New items found (${newItems.length}):\n\n`;
  const fullText = header + lines.join('\n');

  // Telegram text limit safety
  if (fullText.length <= 4000) {
    await safeSend(telenode, chatId, fullText);
    return;
  }

  // Split by count if too long
  const groups = chunk(lines, 40); // adjust chunk size if needed
  for (let i = 0; i < groups.length; i++) {
    const text = `🆕 New items (part ${i + 1}/${groups.length}):\n\n${groups[i].join('\n')}`;
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
    } catch {
      // Ignore if even safeSend fails after retries; just log.
    }
    throw e; // keep original stack
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
