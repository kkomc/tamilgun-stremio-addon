const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Referer": "https://www.google.com/",
  "Upgrade-Insecure-Requests": "1"
};

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-zygote"
            ]
        });
    }
    return browserPromise;
}

async function fetchWithBrowser(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent(BROWSER_HEADERS["User-Agent"]);

  await page.goto(url, { waitUntil: "networkidle2" });

  const html = await page.content();
  await browser.close();

  return html;
}

const BASE = "https://tamilgun.group/";

const manifest = {
  id: "org.tamilgun.tamilgun",
  version: "1.0.0",
  name: "TamilGun Addon",
  description: "Watch TamilGun in Stremio",
  types: ["movies"],
  catalogs: [
  {
    type: "movies",
    id: "tamilgun_hd_movies",
    name: "TamilGun HD Movies"
  },
   {
    type: "movies",
    id: "tamilgun_web_series",
    name: "TamilGun Web Series"
  },
   {
    type: "movies",
    id: "tamilgun_bigg_boss",
    name: "TamilGun Bigg Boss"
  },
   {
    type: "movies",
    id: "tamilgun_trending_movies",
    name: "TamilGun Trending Movies"
  }
  ,
   {
    type: "movies",
    id: "tamilgun_dubbed_movies",
    name: "TamilGun Dubbed Movies"
  }
],
  resources: ["catalog", "stream"]
};

const builder = new addonBuilder(manifest);

// Helper: normalize URL to absolute TamilDhool URL
function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return BASE + url;
  return null;
}

// ✅ Catalog — list shows from homepage
builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    if (type !== "movies" || ( id !== "tamilgun_hd_movies" && id !== "tamilgun_web_series" && id !== "tamilgun_bigg_boss" && id !== "tamilgun_trending_movies" && id !== "tamilgun_dubbed_movies")) {
      return { metas: [] };
    }

    const metas = [];
    let url = BASE;

    if (id === "tamilgun_hd_movies") {
      url = BASE + "video-category/hd-movies/";
    } else if (id === "tamilgun_web_series") {
      url = BASE + "video-category/web-series/";
    } else if (id === "tamilgun_bigg_boss") {
      url = BASE + "video-category/bigg-boss-tamil-season-9/";
    } else if (id === "tamilgun_trending_movies") {
      url = BASE + "trending/";
    } else if (id === "tamilgun_dubbed_movies") {
      url = BASE + "video-category/dubbed-movies/";
    }

    const html = await fetchWithBrowser(url);
    const $ = cheerio.load(html);

    $("article.post-item").each((i, el) => {
        const element = $(el);

        // ✅ Show URL
        const href = element.find(".post-listing-title").first().attr("href");

        // ✅ Poster image
        const poster = element.find(".post-featured-image img").attr("src");

        // ✅ Show name
        const name = element.find(".post-listing-title").text().trim();

        // ✅ Push into metas
        metas.push({
            id: encodeURIComponent(href),
            type: "movies",
            name,
            poster
        });
    });

    return { metas };
  } catch (err) {
    console.error("Catalog error:", err.message);
    return { metas: [] };
  }
});

// ✅ Stream — get video URL for episode
builder.defineStreamHandler(async ({ id }) => {
    const pageUrl = decodeURIComponent(id);

    let finalUrl = null;

    try {
        const browser = await getBrowser();
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        // ✅ Capture only .m3u8 or .mp4 — ignore .ts
        await page.setRequestInterception(true);
        page.on("request", req => {
            const url = req.url();

            // ❌ Ignore .ts segments
            if (url.endsWith(".ts")) {
                req.continue();
                return;
            }

            // ✅ Prefer .m3u8 playlists
            if (url.includes(".m3u8")) {
                finalUrl = url;
            }

            // ✅ Fallback: MP4 direct file
            else if (url.includes(".mp4")) {
                finalUrl = url;
            }

            req.continue();
        });

        // ✅ Load main page
        await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30000 });

        // ✅ Wait for iframe to appear
        await page.waitForSelector("iframe", { timeout: 15000 }).catch(() => null);

        let iframeSrc = await page.$eval("iframe", el => el.src).catch(() => null);

        if (!iframeSrc || iframeSrc === "#" || iframeSrc === "x") {
            await page.close();
            return { streams: [] };
        }

        // ✅ Load iframe
        await page.goto(iframeSrc, { waitUntil: "networkidle2", timeout: 30000 });

        // ✅ Let JS player load (modern Puppeteer replacement for waitForTimeout)
        await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => null);

        if (finalUrl) {
            await page.close();
            return { streams: [{ title: "Server", url: finalUrl }] };
        }

        // ✅ Try nested iframe
        let nestedIframe = await page.$eval("iframe", el => el.src).catch(() => null);

        if (nestedIframe) {
            await page.goto(nestedIframe, { waitUntil: "networkidle2", timeout: 30000 });
            await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => null);
        }

        if (finalUrl) {
            await page.close();
            return { streams: [{ title: "Server", url: finalUrl }] };
        }

        await page.close();
        return { streams: [] };

    } catch (err) {
        console.error("Stream error:", err);
        return { streams: [] };
    }
});

async function fetchPageHTML(url) {
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": "en-US,en;q=0.9"
        }
    });
    return await res.text();
}

async function extractIframeOrVideo(url) {
    if (!isValidUrl(url)) {
    return null;
    }

    const html = await fetchPageHTML(url);
    const $ = cheerio.load(html);

    // ✅ Direct <video src="">
    let video = $("video").attr("src");
    if (video) return video;

    // ✅ First iframe
    let iframe = $("iframe").attr("src");

    if (!iframe || iframe === "#" || iframe === "x" || iframe.startsWith("javascript")) {
        return null;
    }

    if (!iframe) return null;

    if (iframe.startsWith("/")) {
        const u = new URL(url);
        iframe = `${u.origin}${iframe}`;
    }

    // ✅ Load iframe page
    const iframeHtml = await fetchPageHTML(iframe);
    const $$ = cheerio.load(iframeHtml);

    // ✅ Check for <video> inside iframe
    let nestedVideo = $$("video").attr("src");
    if (nestedVideo) return nestedVideo;

    // ✅ Check for nested iframe
    let nestedIframe = $$("iframe").attr("src");
    if (nestedIframe) {
        if (nestedIframe.startsWith("/")) {
            const u = new URL(iframe);
            nestedIframe = `${u.origin}${nestedIframe}`;
        }
        return await extractIframeOrVideo(nestedIframe);
    }

    // ✅ Fallback: find .m3u8 or .mp4 in HTML
    const match = iframeHtml.match(/https?:\/\/[^\s"'<>]+?\.(m3u8|mp4)/i);
    if (match) return match[0];

    return null;
}

function isValidUrl(u) {
    try {
        new URL(u);
        return true;
    } catch {
        return false;
    }
}

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
