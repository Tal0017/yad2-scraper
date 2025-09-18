const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

// ================================
// Fetch Yad2 Page
// ================================
const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        redirect: 'follow',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/100.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    };
    try {
        const res = await fetch(url, requestOptions);
        const text = await res.text();

        // Debug: preview the first 500 characters
        console.log("\n=== HTML Preview ===");
        console.log(text.substring(0, 500));
        console.log("=== End Preview ===\n");

        return text;
    } catch (err) {
        console.log("❌ Error fetching Yad2:", err);
    }
};

// ================================
// Scrape Image URLs
// ================================
const scrapeItemsAndExtractImgUrls = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) throw new Error("Could not get Yad2 response");

    const $ = cheerio.load(yad2Html);
    const titleText = $("title").first().text();

    if (titleText === "ShieldSquare Captcha") {
        throw new Error("Bot detection triggered!");
    }

    // UPDATED SELECTOR:
    // Target ads by stable attribute
    const $feedItems = $('img[data-nagish="feed-item-image"]');

    console.log(`Found ${$feedItems.length} feed images`);

    if ($feedItems.length === 0) {
        throw new Error("Could not find feed items on the page");
    }

    const imageUrls = [];
    $feedItems.each((_, elm) => {
        const imgSrc = $(elm).attr('src');
        if (imgSrc) {
            imageUrls.push(imgSrc.trim());
        }
    });

    console.log("Extracted image URLs:", imageUrls);
    return imageUrls;
};

// ================================
// Check for New Items
// ================================
const checkIfHasNewItem = async (imgUrls, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedUrls = [];

    try {
        savedUrls = require(filePath);
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
    imgUrls.forEach(url => {
        if (!savedUrls.includes(url)) {
            savedUrls.push(url);
            newItems.push(url);
        }
    });

    if (newItems.length > 0) {
        fs.writeFileSync(filePath, JSON.stringify(savedUrls, null, 2));
        await createPushFlagForWorkflow();
    }

    return newItems;
};

// ================================
// Create Push Flag
// ================================
const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "");
};

// ================================
// Main Scrape Workflow
// ================================
const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({ apiToken });

    try {
        await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId);

        const scrapeImgResults = await scrapeItemsAndExtractImgUrls(url);
        const newItems = await checkIfHasNewItem(scrapeImgResults, topic);

        if (newItems.length > 0) {
            for (const item of newItems) {
                await telenode.sendTextMessage(`New item:\n${item}`, chatId);
            }
        } else {
            await telenode.sendTextMessage("No new items were added", chatId);
        }

    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) errMsg = `Error: ${errMsg}`;
        await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId);
        throw new Error(e);
    }
};

// ================================
// Entry Point
// ================================
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
