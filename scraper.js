const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
  const requestOptions = {
    method: 'GET',
    redirect: 'follow'
  };
  try {
    const res = await fetch(url, requestOptions);
    const text = await res.text();

    // Debug: print first 500 chars of HTML to see what we get
    console.log("\n=== Yad2 HTML preview ===");
    console.log(text.substring(0, 500));
    console.log("=== End preview ===\n");

    return text;
  } catch (err) {
    console.log(err);
  }
};

const scrapeItemsAndExtractAdIds = async (url) => {
  const yad2Html = await getYad2Response(url);
  if (!yad2Html) throw new Error("Could not get Yad2 response");

  const $ = cheerio.load(yad2Html);

  // Bot detection check
  const titleText = $("title").first().text();
  if (titleText === "ShieldSquare Captcha") {
    console.log("❌ Bot detection page received");
    throw new Error("Bot detection");
  }

  // Select the ad elements
  const $adItems = $(".item-layout_feedItemBox__Kvh1y");
  console.log(`Found ${$adItems.length} ads on page`);

  // Use unique identifiers for each ad
  const adIds = [];
  $adItems.each((_, elm) => {
    // Best: find a unique ID from a data attribute or link
    const adLink = $(elm).find("a").attr("href");
    const adId = $(elm).attr("id") || adLink || $(elm).text().slice(0, 30);

    if (adId) adIds.push(adId.trim());
  });

  console.log("Extracted Ad IDs:", adIds);
  return adIds;
};

const checkIfHasNewItem = async (adIds, topic) => {
  const filePath = `./data/${topic}.json`;

  let savedIds = [];
  try {
    savedIds = require(filePath);
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      if (!fs.existsSync('data')) fs.mkdirSync('data');
      fs.writeFileSync(filePath, '[]');
    } else {
      console.log(e);
      throw new Error(`Could not read / create ${filePath}`);
    }
  }

  let newItems = [];
  adIds.forEach(id => {
    if (!savedIds.includes(id)) {
      savedIds.push(id);
      newItems.push(id);
    }
  });

  if (newItems.length > 0) {
    fs.writeFileSync(filePath, JSON.stringify(savedIds, null, 2));
    await createPushFlagForWorkflow();
  }

  return newItems;
};

const createPushFlagForWorkflow = () => {
  fs.writeFileSync("push_me", "");
};

const scrape = async (topic, url) => {
  const apiToken = process.env.API_TOKEN || config.telegramApiToken;
  const chatId = process.env.CHAT_ID || config.chatId;
  const telenode = new Telenode({ apiToken });

  try {
    await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId);

    const scrapeAdResults = await scrapeItemsAndExtractAdIds(url);
    const newItems = await checkIfHasNewItem(scrapeAdResults, topic);

    if (newItems.length > 0) {
      // send one message per new ad
      for (const item of newItems) {
        await telenode.sendTextMessage(`New ad found:\n${item}`, chatId);
      }
    } else {
      await telenode.sendTextMessage("No new ads were added", chatId);
    }
  } catch (e) {
    let errMsg = e?.message || "";
    if (errMsg) errMsg = `Error: ${errMsg}`;
    await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId);
    throw new Error(e);
  }
};

const program = async () => {
  await Promise.all(
    config.projects
      .filter(project => {
        if (project.disabled) console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        return !project.disabled;
      })
      .map(async project => {
        await scrape(project.topic, project.url);
      })
  );
};

program();
