const { URL } = require('url');

const scrapeItemsAndExtractImgUrls = async (url) => {
  const yad2Html = await getYad2Response(url);
  if (!yad2Html) throw new Error("Could not get Yad2 response");

  const $ = cheerio.load(yad2Html);
  const titleText = $("title").first().text();
  if (titleText && titleText.toLowerCase().includes("shieldsquare")) {
    console.log("❌ Bot detection page received");
    throw new Error("Bot detection");
  }

  // Prefer attribute-based selectors (more stable than hashed classes)
  const imgSelectors = [
    'img[data-nagish="feed-item-image"]',
    'img[data-testid="image"]',
    'img.item-image',
    '.item-layout_feedItemBox__Kvh1y img' // keep as a last-resort
  ].join(', ');

  const absolute = (u) => {
    try { return new URL(u, url).href; }
    catch { return u; }
  };

  const imageUrls = [];

  // First try to find images inside ad containers (if those containers exist)
  const containers = $('.item-layout_feedItemBox__Kvh1y');
  if (containers.length) {
    containers.each((_, c) => {
      const $c = $(c);
      let $img = $c.find(imgSelectors).first();

      let src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-original') || null;

      // some sites use background-image in style instead of <img>
      if (!src) {
        const style = $c.attr('style') || $img.attr('style') || '';
        const m = style.match(/url\((['"]?)(.*?)\1\)/);
        if (m) src = m[2];
      }

      // if still no src, try to find a link to the ad (better unique id)
      if (!src) {
        const link = $c.find('a').first().attr('href');
        if (link) imageUrls.push(absolute(link));
        return;
      }

      imageUrls.push(absolute(src));
    });
  } else {
    // fallback: global search for any image with our good attributes
    $(imgSelectors).each((_, img) => {
      const $img = $(img);
      const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-original');
      if (src) imageUrls.push(absolute(src));
    });
  }

  // last fallback: find any <img> on the page (not ideal)
  if (!imageUrls.length) {
    $('img').each((_, img) => {
      const s = $(img).attr('src') || $(img).attr('data-src');
      if (s) imageUrls.push(absolute(s));
    });
  }

  // Unique and filtered
  const unique = [...new Set(imageUrls.filter(Boolean))];
  console.log(`Found ${unique.length} candidate images`);
  return unique;
};
