// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 스크린샷
// - 모바일 '가격비교/가격검색' 관련 기능 전부 제거
// - PC '가격비교(pricecompare-pc)'는 유지

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// ---- Firebase Admin SDK 초기화 ----
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

// ---- 유틸: 딜레이 ----
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- 섹션 XPath 정의 ----
//  ⛔ 모바일 pricecompare-* 제외
const SECTION_XPATHS = {
  'powerlink-pc':     "//*[starts-with(@id, 'pcPowerLink_')]/div/div",
  'pricecompare-pc':  "//*[@id='shp_gui_root']/section/div[2]",
  'powerlink-mobile': "//*[starts-with(@id,'mobilePowerLink_')]/section",
};

// ---- XPath로 요소 가져오기 ----
async function getElementByXPath(page, xpath, timeout = 5000) {
  try {
    await page.waitForXPath(xpath, { timeout });
  } catch {
    return null;
  }
  const [elem] = await page.$x(xpath);
  return elem || null;
}

// ---- 모바일 페이지 준비: 헤딩 대기 + lazy-load 트리거 ----
//  (가격비교 키워드 제거)
async function prepareMobilePage(page) {
  try {
    await page.waitForXPath(
      "//h2[contains(normalize-space(), '관련 광고')]",
      { timeout: 10000 }
    );
  } catch {}
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 2000));
    window.scrollTo(0, 0);
  });
}

// ---- 키워드+뷰포트별 캡처 ----
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
      deviceScaleFactor: 3,
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
    await delay(1200);
  } else {
    await delay(600);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '');

  // 🔎 일반 섹션 캡처 루프
  //  - 모바일 pricecompare-* 없음
  //  - PC pricecompare-* 유지
  const sectionKeys = [
    'powerlink-pc',
    'pricecompare-pc',
    'powerlink-mobile',
  ];

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

      // 내부 앵커 대기(옵션)
      try { await page.waitForXPath(`${xpath}//a`, { timeout: 4000 }); } catch {}

      const buf = await elem.screenshot(); // Buffer 반환
      const filePath = `${key}_${viewport.label}_${keyword}_${ts}.png`;
      await bucket.file(filePath).save(buf, { contentType: 'image/png' });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section: key,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url: publicUrl,
      });
      console.log(`✅ 섹션 캡처: ${key} → ${publicUrl}`);
    } catch (err) {
      console.error(`❗ 에러 [${key}/${viewport.label}/${keyword}]`, err.message);
    }
  }

  // 🧾 전체 페이지 캡처
  try {
    if (viewport.label === 'mobile') {
      await page.evaluate(async () => {
        const imgs = Array.from(document.images);
        await Promise.all(
          imgs.map(img =>
            img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; })
          )
        );
      });
    }
    const fullBuf = await page.screenshot({ fullPage: true });
    const fullPath = `fullpage_${viewport.label}_${keyword}_${ts}.png`;
    await bucket.file(fullPath).save(fullBuf, { contentType: 'image/png' });
    const fullUrl = `https://storage.googleapis.com/${bucket.name}/${fullPath}`;
    await db.collection('screenshots').add({
      keyword,
      viewport: viewport.label,
      section: 'fullpage',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      filePath: fullPath,
      url: fullUrl,
    });
    console.log(`🧾 전체 페이지 캡처 완료: ${fullUrl}`);
  } catch (err) {
    console.error(`❗ 에러 [fullpage/${viewport.label}/${keyword}]`, err.message);
  }

  await browser.close();
}

// ---- Entry point ----
(async () => {
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
