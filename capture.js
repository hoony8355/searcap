// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 스크린샷 (경량/저용량 고정 설정 버전)

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// ---------- 압축/형식/배율: 고정값 ----------
const IMG_FORMAT = 'jpeg';     // 'jpeg' 고정
const IMG_QUALITY = 65;        // 1~100
const DEVICE_SCALE_FACTOR = 1.5;
const RESIZE_MAX_WIDTH = 1600; // fullpage 가로폭이 이 값보다 크면 축소
const CONTENT_TYPE = 'image/jpeg';
const EXT = 'jpg';

// sharp는 선택사항(있으면 후처리)
let sharp = null;
try { sharp = require('sharp'); } catch { /* optional */ }

// ---------- Firebase Admin SDK ----------
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
});
const bucket = admin.storage().bucket();
const db = admin.firestore();

// ---------- 유틸 ----------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function compressBuffer(buf, { isFullPage = false } = {}) {
  // sharp가 있으면: 리사이즈(옵션) + 재인코딩
  if (sharp) {
    let img = sharp(buf, { failOn: false });
    if (isFullPage && RESIZE_MAX_WIDTH > 0) {
      const meta = await img.metadata();
      if (meta.width && meta.width > RESIZE_MAX_WIDTH) {
        img = img.resize({ width: RESIZE_MAX_WIDTH, withoutEnlargement: true });
      }
    }
    return await img.jpeg({ quality: IMG_QUALITY, mozjpeg: true }).toBuffer();
  }
  // sharp가 없으면: Puppeteer가 만든 포맷 그대로 사용
  return buf;
}

async function screenshotElemCompressed(elem) {
  // Puppeteer도 elem 수준에서 type/quality 지원
  const raw = await elem.screenshot({
    type: 'jpeg',
    quality: IMG_QUALITY,
  });
  return await compressBuffer(raw, { isFullPage: false });
}

async function screenshotPageCompressed(page, { fullPage = false } = {}) {
  const raw = await page.screenshot({
    fullPage,
    type: 'jpeg',
    quality: IMG_QUALITY,
  });
  return await compressBuffer(raw, { isFullPage: fullPage });
}

// ---------- 섹션 XPATH ----------
const SECTION_XPATHS = {
  'powerlink-pc':     "//*[starts-with(@id, 'pcPowerLink_')]/div/div",
  'pricecompare-pc':  "//*[@id='shp_gui_root']/section/div[2]",
  'powerlink-mobile': "//*[starts-with(@id,'mobilePowerLink_')]/section",
};

async function getElementByXPath(page, xpath, timeout = 5000) {
  try { await page.waitForXPath(xpath, { timeout }); } catch { return null; }
  const [elem] = await page.$x(xpath);
  return elem || null;
}

async function prepareMobilePage(page) {
  try {
    await page.waitForXPath("//h2[contains(normalize-space(), '관련 광고')]", { timeout: 10000 });
  } catch {}
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 1500));
    window.scrollTo(0, 0);
  });
}

async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    defaultViewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: DEVICE_SCALE_FACTOR, // 고정: 1.5
      isMobile: viewport.label === 'mobile',
      hasTouch: viewport.label === 'mobile',
    },
  });

  const page = await browser.newPage();
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    );
  }

  const baseUrl =
    viewport.label === 'mobile'
      ? 'https://m.search.naver.com/search.naver?query='
      : 'https://search.naver.com/search.naver?query=';
  const url = baseUrl + encodeURIComponent(keyword);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    console.error(`❌ 페이지 오픈 실패 [${keyword}/${viewport.label}]`, e.message);
    await browser.close();
    return;
  }

  if (viewport.label === 'mobile') {
    await prepareMobilePage(page);
    await delay(1000);
  } else {
    await delay(500);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const sectionKeys = ['powerlink-pc', 'pricecompare-pc', 'powerlink-mobile'];

  for (const key of sectionKeys) {
    if (viewport.label === 'pc' && key.includes('mobile')) continue;
    if (viewport.label === 'mobile' && key.includes('pc')) continue;

    const xpath = SECTION_XPATHS[key];
    if (!xpath) continue;

    try {
      const elem = await getElementByXPath(page, xpath, 7000);
      if (!elem) {
        console.warn(`❗ [${keyword}/${viewport.label}] 섹션 '${key}' 미발견`);
        continue;
      }

      try { await page.waitForXPath(`${xpath}//a`, { timeout: 4000 }); } catch {}

      const buf = await screenshotElemCompressed(elem);
      const filePath = `${key}_${viewport.label}_${keyword}_${ts}.${EXT}`;
      await bucket.file(filePath).save(buf, { contentType: CONTENT_TYPE, resumable: false });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section: key,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url: publicUrl,
        format: EXT,
        quality: IMG_QUALITY,
        dpr: DEVICE_SCALE_FACTOR,
      });
      console.log(`✅ 섹션 캡처: ${key} → ${publicUrl}`);
    } catch (err) {
      console.error(`❗ 에러 [${key}/${viewport.label}/${keyword}]`, err.message);
    }
  }

  // 전체 페이지 캡처(압축 + 리사이즈)
  try {
    if (viewport.label === 'mobile') {
      await page.evaluate(async () => {
        const imgs = Array.from(document.images);
        await Promise.all(imgs.map(img => img.complete ? 1 : new Promise(r => { img.onload = r; img.onerror = r; })));
      });
    }

    const fullBuf = await screenshotPageCompressed(page, { fullPage: true });
    const fullPath = `fullpage_${viewport.label}_${keyword}_${ts}.${EXT}`;
    await bucket.file(fullPath).save(fullBuf, { contentType: CONTENT_TYPE, resumable: false });
    const fullUrl = `https://storage.googleapis.com/${bucket.name}/${fullPath}`;

    await db.collection('screenshots').add({
      keyword,
      viewport: viewport.label,
      section: 'fullpage',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      filePath: fullPath,
      url: fullUrl,
      format: EXT,
      quality: IMG_QUALITY,
      dpr: DEVICE_SCALE_FACTOR,
      resizedWidth: RESIZE_MAX_WIDTH || null,
    });
    console.log(`🧾 전체 페이지 캡처 완료: ${fullUrl}`);
  } catch (err) {
    console.error(`❗ 에러 [fullpage/${viewport.label}/${keyword}]`, err.message);
  }

  await browser.close();
}

// ---------- Entry ----------
(async () => {
  // 키워드는 기존과 동일하게 환경변수 KEYWORDS 사용(여긴 필요시 하드코딩 가능)
  const keywords = (process.env.KEYWORDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const viewports = [
    { label: 'pc',     width: 1366, height: 768 },
    { label: 'mobile', width: 375,  height: 667 },
  ];

  for (const kw of keywords) {
    for (const vp of viewports) {
      await captureKeyword(kw, vp);
    }
  }
})();
