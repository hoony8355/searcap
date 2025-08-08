const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

/*
 * Naver search screenshot script
 *
 * This script captures two specific advertising sections on a Naver search results page—
 * the Powerlink ads and the price comparison ads—for each keyword and viewport. It
 * uploads the captured images to Firebase Cloud Storage and records metadata in
 * Cloud Firestore. Keyword lists and Firebase credentials are provided via
 * environment variables.
 */

// Decode the service account key from the environment and initialise Firebase.
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  // Optionally set the database URL when using Realtime Database.
  databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
});

const bucket = admin.storage().bucket();
const db = admin.firestore();

/**
 * Attempts to locate a section on the page. It first tries a direct CSS selector
 * (fallbackSelector). If that fails, it searches for an element containing
 * headingText and then returns its nearest parent element that contains at
 * least two links. This heuristic helps locate sections even if Naver
 * restructures its DOM.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} headingText - Korean heading text (e.g. "파워링크", "가격비교")
 * @param {string} fallbackSelector - CSS selector known to match the desired section
 * @returns {Promise<import('puppeteer').ElementHandle|null>}
 */
async function findSection(page, headingText, fallbackSelector) {
  let handle = null;
  if (fallbackSelector) {
    try {
      handle = await page.$(fallbackSelector);
    } catch (_) {
      // Ignore selector failures and fall back to text search
    }
  }
  if (handle) {
    return handle;
  }
  // Use XPath to find a node whose text contains the heading text. normalize-space()
  // collapses whitespace so we can reliably match the Korean heading label.
  const [heading] = await page.$x(
    `//*[contains(normalize-space(), '${headingText}')]`
  );
  if (!heading) {
    return null;
  }
  // Traverse upward until we find a container with multiple links (heuristic for ad blocks).
  return await heading.evaluateHandle(node => {
    let el = node.parentElement;
    while (el) {
      if (el.querySelectorAll('a').length >= 2) {
        return el;
      }
      el = el.parentElement;
    }
    // Fall back to the heading itself if no suitable parent is found
    return node;
  });
}

/**
 * Captures both advertising sections for a single keyword and viewport. The
 * images are uploaded to Firebase Storage and metadata is stored in Firestore.
 *
 * @param {string} keyword
 * @param {{label: string, width: number, height: number}} viewport
 */
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height });
  const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(
    keyword
  )}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const now = new Date();
  const timestampLabel = now.toISOString().replace(/[:.]/g, '');

  // Define the sections to capture. Adjust selectors based on actual page markup.
  const sections = [
    {
      label: 'powerlink',
      heading: '파워링크',
      selector: '.power_link',
    },
    {
      label: 'pricecompare',
      heading: '가격비교',
      selector: '.price_compare',
    },
  ];

  for (const section of sections) {
    try {
      const elementHandle = await findSection(page, section.heading, section.selector);
      if (!elementHandle) {
        console.warn(`[${keyword}/${viewport.label}] 섹션 '${section.label}'을 찾을 수 없습니다.`);
        continue;
      }
      const screenshot = await elementHandle.screenshot({ encoding: 'binary' });
      const filePath = `${section.label}_${viewport.label}_${keyword}_${timestampLabel}.png`;
      // Upload the screenshot to Firebase Storage
      await bucket
        .file(filePath)
        .save(screenshot, { contentType: 'image/png' });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      // Record metadata in Firestore
      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section: section.label,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url: publicUrl,
      });
    } catch (err) {
      console.error(`에러: [${keyword}/${viewport.label}/${section.label}]`, err);
    }
  }
  await browser.close();
}

/**
 * Entry point: iterates over all keywords and viewports.
 */
async function main() {
  const keywordsEnv = process.env.KEYWORDS || '';
  const keywords = keywordsEnv
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
  if (keywords.length === 0) {
    console.error('키워드 목록이 비어 있습니다. KEYWORDS 환경변수를 설정해 주세요.');
    return;
  }
  const viewports = [
    { label: 'pc', width: 1366, height: 768 },
    { label: 'mobile', width: 375, height: 667 },
  ];
  for (const keyword of keywords) {
    for (const vp of viewports) {
      try {
        await captureKeyword(keyword, vp);
      } catch (err) {
        console.error(`키워드 ${keyword} / ${vp.label} 처리 중 에러`, err);
      }
    }
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
});