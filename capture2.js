// capture2.js
// Purpose: Search Naver mobile for a keyword or URL and attempt to capture the price
// search section using multiple capture strategies. The script is designed to be
// executed in Node via GitHub Actions or locally. It uploads each captured image
// to Firebase Storage (if configured) and records metadata in Firestore. When
// DRY_RUN is set, it simply saves the images locally for inspection.
//
// Usage examples:
//   KEYWORDS="페이퍼팝" node capture2.js
//   node capture2.js --keyword "페이퍼팝"
//   node capture2.js --url "https://m.search.naver.com/search.naver?query=%ED%8E%98%EC%9D%B4%ED%8D%BC%ED%8C%9D"
//
// Required environment variables for Firebase uploads:
//   FIREBASE_SERVICE_ACCOUNT_BASE64  (base64 encoded service account JSON)
//   FIREBASE_PROJECT_ID
//   FIREBASE_STORAGE_BUCKET
// Optional environment variables:
//   FIREBASE_DATABASE_URL    (for Firestore)
//   DEVICE_SCALE_FACTOR      (screen scale, default 3)
//   CAP_PREFIX               (prefix for file names in bucket)
//   DRY_RUN                  (if set, skip uploads and only save locally)
//   USE_SIGNED_URL           (set to '1' to use signed URLs instead of public URLs)
//   SIGNED_URL_DAYS          (signed URL validity days, default 7)

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

let bucket = null;
let db = null;

// Initialise Firebase
function initFirebase() {
  if (process.env.DRY_RUN) {
    console.log('⚠️  DRY_RUN set: Firebase uploads will be skipped.');
    return;
  }
  const admin = require('firebase-admin');
  const serviceAccountJson = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    'base64'
  ).toString('utf8');
  const serviceAccount = JSON.parse(serviceAccountJson);
  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
    });
  }
  bucket = admin.storage().bucket();
  db = admin.firestore();
}

// Utility: sleep
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Setup DSF (device scale factor) from env (1–6 recommended)
const dsf = Math.max(1, Math.min(6, parseInt(process.env.DEVICE_SCALE_FACTOR || '3', 10)));
const CAP_PREFIX = (process.env.CAP_PREFIX || '').replace(/^\/+/g, '').replace(/\/+/g, '/');
const SAVE_DIR = path.join(process.cwd(), 'captures');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR);

// Generate timestamp string for unique file naming
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '');
}

// Sanitize strings for filenames/paths
function slug(str) {
  return (str || '')
    .toString()
    .replace(/[\s]+/g, '_')
    .replace(/[\\/\?<>\:\\*\|\"]+/g, '')
    .slice(0, 80);
}

// Upload PNG to Firebase Storage and record metadata in Firestore
async function uploadImage(buffer, { keyword, variant, ts }) {
  const fileName = `price-search-${slug(keyword)}-${ts}-${variant}.png`;
  const gcsPath = CAP_PREFIX ? `${CAP_PREFIX}/${fileName}` : fileName;

  // Always save locally for debugging
  const localPath = path.join(SAVE_DIR, fileName);
  fs.writeFileSync(localPath, buffer);

  // If DRY_RUN, don't upload and don't record metadata
  if (process.env.DRY_RUN) {
    return { url: null, gcsPath, localPath };
  }

  // Upload file to Firebase Storage
  await bucket.file(gcsPath).save(buffer, { contentType: 'image/png', resumable: false });

  let url;
  // Determine how to generate URL
  if (process.env.USE_SIGNED_URL === '1') {
    const days = Math.max(1, parseInt(process.env.SIGNED_URL_DAYS || '7', 10));
    const expires = Date.now() + days * 24 * 60 * 60 * 1000;
    const [signed] = await bucket
      .file(gcsPath)
      .getSignedUrl({ action: 'read', expires });
    url = signed;
  } else {
    try {
      // Attempt to make the file publicly readable
      await bucket.file(gcsPath).makePublic();
      url = `https://storage.googleapis.com/${bucket.name}/${gcsPath}`;
    } catch (err) {
      // Fall back to signed URL if public access is not allowed
      const [signed] = await bucket
        .file(gcsPath)
        .getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      url = signed;
    }
  }

  // Record metadata in Firestore
  if (db) {
    try {
      await db.collection('screenshots').add({
        keyword,
        viewport: 'mobile',
        section: 'price-search',
        variant,
        filePath: gcsPath,
        url,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('⚠️  Firestore error:', err.message);
    }
  }

  return { url, gcsPath, localPath };
}

// Launch a mobile emulated Puppeteer browser
async function launchMobile() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      '--window-size=390,844',
    ],
    defaultViewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: dsf,
      isMobile: true,
      hasTouch: true,
    },
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  );
  return { browser, page };
}

// Inject CSS to disable animations and sticky elements
async function disableAnimations(page) {
  await page.addStyleTag({
    content: `
      * { animation: none !important; transition: none !important; }
      *::before, *::after { animation: none !important; transition: none !important; }
      [style*="position: sticky"], [style*="position:fixed"] { position: static !important; }
      header, footer, nav, [class*="sticky"], [class*="Fixed"], [class*="floating"], [class*="Floating"] { display: none !important; }
      body { overscroll-behavior: contain !important; }
    `,
  });
}

// Navigate to the search page and trigger initial lazy load
async function openSearch(page, keywordOrUrl) {
  const isUrl = /^https?:\/\//i.test(keywordOrUrl);
  const url = isUrl
    ? keywordOrUrl
    : `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keywordOrUrl)}`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  // Trigger lazy-load by scrolling down and back up
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    window.scrollTo(0, 0);
  });
  await disableAnimations(page);
}

// Identify the price search section using headings or text patterns
async function resolvePriceSearchSelector(page) {
  return await page.evaluate(() => {
    // Candidate selectors to test
    const candidates = [];

    // 1. Check for known ID used by Naver price compare module (#shp_tli_root)
    if (document.querySelector('#shp_tli_root')) {
      candidates.push('#shp_tli_root');
    }

    // 2. Search for headings containing "가격검색" or "가격검색 결과"
    const heading = Array.from(document.querySelectorAll('h2, h3, h4, strong')).find((el) =>
      /가격검색/.test((el.textContent || '').trim())
    );
    if (heading) {
      // Choose a close container (section or div) around the heading
      let container = heading.closest('section');
      if (!container) container = heading.closest('div');
      if (container) candidates.push(getUniqueSelector(container));
    }

    // 3. Look for module pages starting with "guide-mobile-module__page___" containing 가격 or 가격검색
    const module = Array.from(
      document.querySelectorAll('[class^="guide-mobile-module__page___"]')
    ).find((el) => /가격검색|가격 정보/.test((el.textContent || '').replace(/\s+/g, ' ')));
    if (module) {
      candidates.push(getUniqueSelector(module));
    }

    // 4. Fallback: search any section/div containing both "가격" and "원" (KR currency)
    const fallback = Array.from(document.querySelectorAll('section, div')).find((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, '');
      return /가격/.test(txt) && /[0-9,]+원/.test(txt);
    });
    if (fallback) {
      candidates.push(getUniqueSelector(fallback));
    }

    // Return the first valid selector
    return candidates.find((sel) => !!sel) || null;

    // Helper: generate a simple unique selector for an element
    function getUniqueSelector(element) {
      if (!element) return null;
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      let current = element;
      for (let i = 0; current && i < 5; i++) {
        let selector = current.nodeName.toLowerCase();
        if (current.classList && current.classList.length) {
          selector += '.' + Array.from(current.classList)
            .slice(0, 2)
            .map((c) => CSS.escape(c))
            .join('.');
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (ch) => ch.nodeName.toLowerCase() === current.nodeName.toLowerCase()
          );
          if (siblings.length > 1) {
            selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          }
        }
        parts.unshift(selector);
        current = parent;
      }
      return parts.join(' > ');
    }
  });
}

// Wait until images and fonts in the section are fully loaded
async function stabilizeSection(page, selector, timeout = 10000) {
  // Scroll into view
  try {
    await page.$eval(selector, (el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
  } catch {
    // ignore
  }
  await sleep(300);

  // Force images to eager and fix srcset for high resolution
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return;
    element.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      if (img.srcset) {
        const last = img.srcset.split(',').pop();
        if (last) {
          const url = last.trim().split(' ')[0];
          if (url) img.src = url;
        }
      }
      img.style.visibility = 'visible';
      img.style.opacity = '1';
    });
  }, selector);

  // Wait for fonts to load
  try {
    await page.evaluate(() => document.fonts && document.fonts.ready);
  } catch {}

  // Wait until some text and images appear
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const textOK = (el.innerText || '').trim().length > 30;
        const images = Array.from(el.querySelectorAll('img'));
        const imagesOK = images.every((img) => img.complete && img.naturalWidth > 0);
        return textOK && imagesOK;
      },
      { timeout },
      selector
    );
  } catch {
    // If timeout, continue anyway
  }

  await sleep(200);
}

// Compute clipping rectangle for page screenshot from DOM rect and optional padding
async function getClipForSection(page, selector, pad = 0) {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.floor((window.scrollX || window.pageXOffset) + r.left),
      y: Math.floor((window.scrollY || window.pageYOffset) + r.top),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height),
      docWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth
      ),
      docHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      ),
    };
  }, selector);
  if (!rect) throw new Error('rect is null');

  const clip = {
    x: Math.max(0, rect.x - pad),
    y: Math.max(0, rect.y - pad),
    width: Math.max(1, rect.width + pad * 2),
    height: Math.max(1, rect.height + pad * 2),
  };
  // Clamp within document dimensions
  clip.width = Math.min(clip.width, rect.docWidth - clip.x);
  clip.height = Math.min(clip.height, rect.docHeight - clip.y);
  return clip;
}

// Capture strategy: page screenshot with bounding box clip
async function captureRectClip(page, selector, keyword, ts) {
  const clip = await getClipForSection(page, selector, 0);
  const buffer = await page.screenshot({ clip, type: 'png' });
  const result = await uploadImage(buffer, { keyword, variant: 'rect_clip', ts });
  return { variant: 'rect_clip', ok: true, ...result };
}

// Capture strategy: page screenshot with padded bounding box clip
async function captureRectClipPad(page, selector, keyword, ts) {
  const pad = Math.round(8 * dsf);
  const clip = await getClipForSection(page, selector, pad);
  const buffer = await page.screenshot({ clip, type: 'png' });
  const result = await uploadImage(buffer, { keyword, variant: 'rect_clip_pad', ts });
  return { variant: 'rect_clip_pad', ok: true, ...result };
}

// Capture strategy: high-DPI bounding box clip
async function captureRectClipHiDpi(page, selector, keyword, ts) {
  const el = await page.$(selector);
  if (!el) throw new Error('Element is null');
  const box = await el.boundingBox();
  if (!box) throw new Error('Bounding box not available');
  // Increase scale factor within bounds
  const highDsf = Math.min(dsf * 2, 6);
  await page.setViewport({
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
    deviceScaleFactor: highDsf,
    isMobile: true,
    hasTouch: true,
  });
  const clip = await getClipForSection(page, selector, 0);
  const buffer = await page.screenshot({ clip, type: 'png' });
  const result = await uploadImage(buffer, { keyword, variant: 'rect_clip_hidpi', ts });
  return { variant: 'rect_clip_hidpi', ok: true, ...result };
}

// Capture strategy: element screenshot (fallback)
async function captureElement(page, selector, keyword, ts) {
  const el = await page.$(selector);
  if (!el) throw new Error('Element not found');
  const buffer = await el.screenshot({ type: 'png' });
  const result = await uploadImage(buffer, { keyword, variant: 'element', ts });
  return { variant: 'element', ok: true, ...result };
}

// Capture strategy: isolate DOM (clone computed styles and render on blank page)
async function captureIsolatedDom(page, selector, keyword, ts) {
  const html = await page.evaluate(async (sel) => {
    const target = document.querySelector(sel);
    if (!target) return null;
    // Wait for fonts
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch {}
    }
    // Eager load images in the section
    target.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      if (img.srcset) {
        const last = img.srcset.split(',').pop();
        if (last) {
          const url = last.trim().split(' ')[0];
          if (url) img.src = url;
        }
      }
    });
    function cloneWithStyles(node) {
      const clone = node.cloneNode(false);
      if (node.nodeType === 1) {
        const styles = window.getComputedStyle(node);
        const styleString = Array.from(styles)
          .map((prop) => `${prop}:${styles.getPropertyValue(prop)};`)
          .join('');
        clone.setAttribute('style', styleString);
        if (node.tagName === 'IMG' && node.src) clone.setAttribute('src', node.src);
      }
      node.childNodes.forEach((child) => clone.appendChild(cloneWithStyles(child)));
      return clone;
    }
    const rect = target.getBoundingClientRect();
    target.style.width = rect.width + 'px';
    const cloned = cloneWithStyles(target);
    const wrapper = document.createElement('div');
    wrapper.style.padding = '12px';
    wrapper.style.background = '#fff';
    wrapper.style.width = rect.width + 'px';
    wrapper.appendChild(cloned);
    const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#fff;}</style></head><body>${wrapper.outerHTML}</body></html>`;
    return doc;
  }, selector);
  if (!html) throw new Error('Could not clone section');

  // Create a new page to render cloned section
  const iso = await page.browser().newPage();
  // Set a large viewport to capture all content
  await iso.setViewport({ width: 1000, height: 1000, deviceScaleFactor: dsf });
  await iso.setContent(html, { waitUntil: 'load' });
  // Wait for fonts and images to load in isolated page
  try {
    await iso.evaluate(() => document.fonts && document.fonts.ready);
  } catch {}
  await sleep(200);
  const rect = await iso.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { width: Math.ceil(b.width), height: Math.ceil(b.height) };
  });
  await iso.setViewport({ width: rect.width, height: rect.height, deviceScaleFactor: dsf });
  const buffer = await iso.screenshot({ clip: { x: 0, y: 0, width: rect.width, height: rect.height }, type: 'png' });
  await iso.close();
  const result = await uploadImage(buffer, { keyword, variant: 'isolated_dom', ts });
  return { variant: 'isolated_dom', ok: true, ...result };
}

// Main routine: run capture for a single keyword or URL
async function runCapture(target) {
  initFirebase();
  const { browser, page } = await launchMobile();
  const ts = stamp();
  const isUrl = /^https?:\/\//i.test(target);
  const keyword = isUrl ? '(viaURL)' : target;
  const results = [];
  try {
    await openSearch(page, target);
    // Resolve the selector of price search section
    let selector = null;
    for (let i = 0; i < 3 && !selector; i++) {
      selector = await resolvePriceSearchSelector(page);
      if (!selector) {
        await sleep(1000);
        await page.evaluate(() => window.scrollBy(0, 600));
      }
    }
    if (!selector) throw new Error('Unable to detect price search section');

    await page.waitForSelector(selector, { timeout: 20000 });
    await stabilizeSection(page, selector, 15000);

    // Try capturing with different strategies
    // Define capture strategies. Prioritise the element screenshot strategy first,
    // since in practice this often yields a clean capture when the section
    // detection is correct. Follow up with various rect clip variants and
    // isolated DOM as fallbacks.
    const strategies = [
      captureElement,
      captureRectClip,
      captureRectClipPad,
      captureRectClipHiDpi,
      captureIsolatedDom,
    ];

    for (const strategy of strategies) {
      const name = strategy.name.replace(/^capture/, '').toLowerCase();
      try {
        const result = await strategy(page, selector, keyword, ts);
        results.push({ variant: result.variant, ok: true, url: result.url });
        console.log(`✅ ${result.variant} success: ${result.url || result.gcsPath}`);
      } catch (error) {
        results.push({ variant: name, ok: false, error: error.message });
        console.warn(`⚠️  ${name} failed: ${error.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Capture failed for '${target}':`, err.message);
  } finally {
    await browser.close();
  }

  console.log('──── Capture summary ────');
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ ${r.variant}: ${r.url}`);
    } else {
      console.log(`❌ ${r.variant}: ${r.error}`);
    }
  }
}

// CLI entry: parse arguments and run captures on provided targets
(async () => {
  const args = process.argv.slice(2);
  const getArg = (name, defaultVal) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const keywordArg = getArg('keyword');
  const urlArg = getArg('url');
  const envKeywords = (process.env.KEYWORDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let targets = [];
  if (urlArg) {
    targets = [urlArg];
  } else if (keywordArg) {
    targets = [keywordArg];
  } else if (envKeywords.length > 0) {
    targets = envKeywords;
  } else {
    console.error('Usage: node capture2.js --keyword "<keyword>" OR --url "<mobile URL>" OR set KEYWORDS env');
    process.exit(1);
  }

  for (const t of targets) {
    console.log(`\n▶ Starting capture for: ${t}`);
    await runCapture(t);
  }
})();
