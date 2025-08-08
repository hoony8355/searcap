// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고 스크린샷 및 전체 페이지 캡처 스크립트

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// Firebase Admin SDK 초기화
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

// 섹션 XPath 정의 (동적 ID 지원)
const SECTION_XPATHS = {
  'powerlink-pc': "//*[starts-with(@id, 'pcPowerLink_')]/div/div",
  'pricecompare-pc': "//*[@id='shp_gui_root']/section/div[2]",
  'powerlink-mobile': "//*[starts-with(@id,'mobilePowerLink_')]/section",
  'pricecompare-mobile': "//*[@id='shp_tli_root']",
};

// XPath로 요소 가져오기
async function getElementByXPath(page, xpath, timeout = 5000) {
  try {
    await page.waitForXPath(xpath, { timeout });
  } catch {
    return null;
  }
  const [elem] = await page.$x(xpath);
  return elem || null;
}

// 모바일 페이지 준비: 헤딩 대기 + lazy-load 트리거
async function prepareMobilePage(page) {
  try {
    await page.waitForXPath(
      "//h2[contains(normalize-space(), '관련 광고') or contains(normalize-space(),'가격비교')]",
      { timeout: 10000 }
    );
  } catch {}
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 2000));
    window.scrollTo(0, 0);
  });
}

// 키워드+뷰포트별 캡처
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height });
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
  }

  const baseUrl =
    viewport.label === 'mobile'
      ? 'https://m.search.naver.com/search.naver?query='
      : 'https://search.naver.com/search.naver?query=';
  const url = baseUrl + encodeURIComponent(keyword);

  // 페이지 열고 초기 대기
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (viewport.label === 'mobile') {
    await prepareMobilePage(page);
    await page.waitForTimeout(5000);
  } else {
    await page.waitForTimeout(2000);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const sectionKeys = [
    'powerlink-pc',
    'pricecompare-pc',
    'powerlink-mobile',
    'pricecompare-mobile',
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

      // 모바일 가격비교 섹션: 로딩 검증
      if (viewport.label === 'mobile' && key === 'pricecompare-mobile') {
        // 화면 중앙으로 이동
        await elem.evaluate(el => el.scrollIntoView({ block: 'center' }));
        // 충분히 대기 (최대 20초)
        await page.waitForTimeout(20000);
        // 텍스트 로딩 완료 대기
        try {
          await page.waitForFunction(
            el => el && el.innerText && el.innerText.trim().length > 50,
            { timeout: 10000 },
            elem
          );
        } catch {
          console.warn(`❗ [${keyword}/mobile] pricecompare-mobile: 텍스트 로딩 대기 초과`);
        }
        // 이미지 로딩 완료 대기
        await page.evaluate(async el => {
          const imgs = Array.from(el.querySelectorAll('img'));
          await Promise.all(
            imgs.map(img =>
              img.complete
                ? Promise.resolve()
                : new Promise(r => { img.onload = r; img.onerror = r; })
            )
          );
        }, elem);
        await page.waitForTimeout(500);
      }

      // 스크린샷 저장
      const buf = await elem.screenshot({ encoding: 'binary' });
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
    } catch (err) {
      console.error(`❗ 에러 [${key}/${viewport.label}/${keyword}]`, err);
    }
  }

  // 전체 페이지 캡처
  try {
    if (viewport.label === 'mobile') {
      await page.evaluate(async () => {
        const imgs = Array.from(document.images);
        await Promise.all(
          imgs.map(img =>
            img.complete
              ? Promise.resolve()
              : new Promise(r => { img.onload = r; img.onerror = r; })
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
  } catch (err) {
    console.error(`❗ 에러 [fullpage/${viewport.label}/${keyword}]`, err);
  }

  await browser.close();
}

(async () => {
  const keywords = (process.env.KEYWORDS || '')
    .split(',')
    .map(s => s.trim())
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
