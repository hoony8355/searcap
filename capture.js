// Improved capture script for Naver search results
// This version focuses on improving the mobile captures by ensuring that
// dynamic modules are fully loaded before taking screenshots.
// It also uses XPath patterns with starts-with to capture entire
// advertisement sections that have dynamic IDs.

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// Initialise Firebase from environment variables. The service account
// credentials are provided via FIREBASE_SERVICE_ACCOUNT_BASE64.
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'),
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
});
const bucket = admin.storage().bucket();
const db = admin.firestore();

// Define static XPath expressions for each section. Dynamic IDs are handled
// using starts-with() so that the trailing random tokens do not matter.
const SECTION_XPATHS = {
  'powerlink-pc': "//*[starts-with(@id, 'pcPowerLink_')]/div/div",
  'pricecompare-pc': "//*[@id='shp_gui_root']/section/div[2]",
  'powerlink-mobile': "//*[starts-with(@id,'mobilePowerLink_')]/section",
  'pricecompare-mobile': "//*[@id='shp_tli_root']",
};

/**
 * Returns the first element matching the given XPath. Optionally waits for
 * at least one link inside the element to ensure the module has populated
 * its content. If the element does not appear within the timeout, null
 * is returned.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} xpath
 * @param {number} timeout
 */
async function getElementByXPath(page, xpath, timeout = 5000) {
  try {
    // Wait for the element itself to appear
    await page.waitForXPath(xpath, { timeout });
  } catch {
    return null;
  }
  const [elem] = await page.$x(xpath);
  return elem || null;
}

/**
 * Ensures that dynamic modules on the mobile site have time to render. It
 * waits for advertisement module headings to appear and scrolls down to
 * trigger lazy loading of images and text, then back to the top. This
 * prevents captures of blank or misaligned sections.
 *
 * @param {import('puppeteer').Page} page
 */
async function prepareMobilePage(page) {
  // Wait for any of the relevant headings to appear
  try {
    await page.waitForXPath(
      "//h2[contains(normalize-space(), '관련 광고') or contains(normalize-space(),'가격비교')]",
      { timeout: 10000 },
    );
  } catch {
    // continue even if headings do not appear within the timeout
  }
  // Scroll to the bottom to trigger lazy loading
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((res) => setTimeout(res, 2000));
    // Scroll back to top for consistent captures
    window.scrollTo(0, 0);
  });
}

/**
 * Captures all sections and full page for a given keyword and viewport.
 * Results are uploaded to Cloud Storage and metadata is recorded in
 * Firestore.
 *
 * @param {string} keyword
 * @param {{label: string, width: number, height: number}} viewport
 */
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage();
  // Set viewport and user-agent
  await page.setViewport({ width: viewport.width, height: viewport.height });
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    );
  }
  // Construct URL using mobile domain when needed
  const base =
    viewport.label === 'mobile'
      ? 'https://m.search.naver.com/search.naver?query='
      : 'https://search.naver.com/search.naver?query=';
  const url = `${base}${encodeURIComponent(keyword)}`;
  // Navigate and wait for initial DOM
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Additional waits for mobile pages
  if (viewport.label === 'mobile') {
    await prepareMobilePage(page);
  } else {
    // PC: short static delay to allow modules to populate
    await page.waitForTimeout(2000);
  }
  // Timestamp label for filenames
  const tsLabel = new Date().toISOString().replace(/[:.]/g, '');
  // List of section keys to capture plus fullpage
  const sectionKeys = [
    'powerlink-pc',
    'pricecompare-pc',
    'powerlink-mobile',
    'pricecompare-mobile',
  ];
  for (const key of sectionKeys) {
    // Skip irrelevant keys for this viewport
    if (viewport.label === 'pc' && key.includes('mobile')) continue;
    if (viewport.label === 'mobile' && key.includes('pc')) continue;
    const xpath = SECTION_XPATHS[key];
    if (!xpath) continue;
    try {
      const elem = await getElementByXPath(page, xpath, 7000);
      if (!elem) {
        console.warn(`[${keyword}/${viewport.label}] 섹션 '${key}'을 찾지 못했습니다.`);
        continue;
      }
      // Ensure the content inside has had time to load by waiting for links or images
      try {
        await page.waitForXPath(`${xpath}//a`, { timeout: 5000 });
      } catch {
        // continue even if links are not found
      }

      // For mobile price comparison, scroll the element into view and wait
      if (viewport.label === 'mobile' && key === 'pricecompare-mobile') {
        // Bring the element into the center of the viewport to trigger lazy layouting
        await elem.evaluate(el => {
          el.scrollIntoView({ behavior: 'auto', block: 'center' });
        });
        // Wait a bit longer for the text to render inside the container
        try {
          await page.waitForFunction(
            el => el && el.innerText && el.innerText.trim().length > 50,
            { timeout: 7000 },
            elem,
          );
        } catch {
          // Even if text doesn't meet criteria, proceed
        }
      }
      const buf = await elem.screenshot({ encoding: 'binary' });
      const filePath = `${key}_${viewport.label}_${keyword}_${tsLabel}.png`;
      await bucket.file(filePath).save(buf, { contentType: 'image/png' });
      const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section: key,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url,
      });
    } catch (err) {
      console.error(`❗ 에러 [${key}/${viewport.label}/${keyword}]`, err);
    }
  }
  // Capture full page (always)
  try {
    // For mobile, wait for images to finish loading to avoid blank placeholders
    if (viewport.label === 'mobile') {
      await page.evaluate(async () => {
        const images = Array.from(document.images);
        await Promise.all(
          images.map(
            (img) =>
              img.complete ||
              new Promise((resolve) => {
                img.addEventListener('load', resolve);
                img.addEventListener('error', resolve);
              }),
          ),
        );
      });
    }
    const full = await page.screenshot({ fullPage: true });
    const fullPath = `fullpage_${viewport.label}_${keyword}_${tsLabel}.png`;
    await bucket.file(fullPath).save(full, { contentType: 'image/png' });
    const fullUrl = `https://storage.googleapis.com/${bucket.name}/${fullPath}`;
    await db.collection('screenshots').add({
      keyword,
      viewport: viewport.label,
      section: 'fullpage',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      filePath: fullPath,
      url: fullUrl,
    });
  } catch (err) {
    console.error(`❗ 에러 [fullpage/${viewport.label}/${keyword}]`, err);
  }
  await browser.close();
}

// Entry point: read keywords from KEYWORDS env and iterate over viewports
;(async () => {
  const keywordsEnv = process.env.KEYWORDS || '';
  const keywords = keywordsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const viewports = [
    { label: 'pc', width: 1366, height: 768 },
    { label: 'mobile', width: 375, height: 667 },
  ];
  for (const kw of keywords) {
    for (const vp of viewports) {
      await captureKeyword(kw, vp);
    }
  }
})();
