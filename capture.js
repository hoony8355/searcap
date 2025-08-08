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
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const bucket = admin.storage().bucket();
const db = admin.firestore();

// 섹션 컨테이너 찾기
async function getSectionContainer(page, selector, text) {
  let handle = selector ? await page.$(selector) : null;
  if (!handle && text) {
    const [heading] = await page.$x(`//*[contains(normalize-space(), '${text}')]`);
    handle = heading;
  }
  if (!handle) return null;

  // 가장 가까운 section 요소 찾기
  let container = await handle.evaluateHandle(el => el.closest('section'));
  const containerJson = await container.jsonValue().catch(() => null);
  if (!containerJson) {
    container = await handle.evaluateHandle(el => {
      let node = el;
      while (node) {
        if (node.querySelectorAll && node.querySelectorAll('a').length >= 3) {
          return node;
        }
        node = node.parentElement;
      }
      return el;
    });
  }
  return container;
}

// 키워드+뷰포트별 캡처
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
  }
  await page.setViewport({ width: viewport.width, height: viewport.height });

  const baseUrl =
    viewport.label === 'mobile'
      ? 'https://m.search.naver.com/search.naver?query='
      : 'https://search.naver.com/search.naver?query=';
  await page.goto(baseUrl + encodeURIComponent(keyword), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const ts = new Date().toISOString().replace(/[:.]/g, '');

  const sections = [
    { label: 'powerlink-pc',       selector: 'h2.title',                            text: '파워링크' },
    { label: 'pricecompare-pc',    selector: 'h2.header-pc-module__title',          text: '네이버 가격비교' },
    { label: 'powerlink-mobile',   selector: 'div.title_wrap > span.sub',          text: '관련 광고' },
    { label: 'pricecompare-mobile',selector: 'h2.header-mobile-module__title',       text: '네이버 가격비교' },
    { label: 'fullpage',           selector: null,                                 text: null },
  ];

  for (const sec of sections) {
    try {
      if (sec.label === 'fullpage') {
        const filePath = `${sec.label}_${viewport.label}_${keyword}_${ts}.png`;
        const buffer = await page.screenshot({ fullPage: true });
        await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
        const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        await db.collection('screenshots').add({
          keyword, viewport: viewport.label, section: sec.label,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          filePath, url,
        });
        continue;
      }

      const container = await getSectionContainer(page, sec.selector, sec.text);
      if (!container) {
        console.warn(`❗ [${keyword}/${viewport.label}/${sec.label}] 섹션을 찾지 못했습니다.`);
        continue;
      }

      const filePath = `${sec.label}_${viewport.label}_${keyword}_${ts}.png`;
      const buffer = await container.screenshot({ encoding: 'binary' });
      await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
      const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      await db.collection('screenshots').add({
        keyword, viewport: viewport.label, section: sec.label,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath, url,
      });
    } catch (err) {
      console.error(`❗ 에러 [${keyword}/${viewport.label}/${sec.label}]`, err);
    }
  }

  await browser.close();
}

// 실행 진입점
(async () => {
  const keywords = (process.env.KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean);
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
