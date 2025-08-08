```js
// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고(파워링크, 가격비교/쇼핑정보) 및 전체 페이지 스크린샷 스크립트

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// 1) Firebase Admin SDK 초기화
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

/**
 * 주어진 헤딩 텍스트나 CSS 셀렉터로 섹션을 찾는 유틸
 */
async function findSection(page, headingText, fallbackSelector) {
  // 1) CSS selector 시도
  if (fallbackSelector) {
    try {
      const el = await page.$(fallbackSelector);
      if (el) return el;
    } catch {}
  }
  // 2) XPath로 헤딩 텍스트 검색
  const [heading] = await page.$x(`//*[contains(normalize-space(), '${headingText}')]`);
  if (!heading) return null;
  // 3) 부모 탐색: 링크 2개 이상 포함된 컨테이너
  return await heading.evaluateHandle(node => {
    let el = node.closest('section') || node.parentElement;
    while (el) {
      if (el.querySelectorAll('a').length >= 2) return el;
      el = el.parentElement;
    }
    return node;
  });
}

/**
 * 키워드·뷰포트별 섹션 및 전체 페이지 캡처
 */
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: 'new' });
  const page = await browser.newPage();

  // 모바일은 iPhone UA, m.search 사용
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: viewport.width, height: viewport.height });
  } else {
    await page.setViewport({ width: viewport.width, height: viewport.height });
  }

  const baseUrl = viewport.label === 'mobile'
    ? 'https://m.search.naver.com/search.naver?query='
    : 'https://search.naver.com/search.naver?query=';
  const url = `${baseUrl}${encodeURIComponent(keyword)}`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 동적 로딩 대기
  await page.waitForTimeout(3000);

  const now = new Date();
  const timestampLabel = now.toISOString().replace(/[:.]/g, '');

  // 캡처할 섹션 정의
  const sections = [
    { label: 'powerlink',   heading: '파워링크',      selector: '.power_link, h2.title' },
    { label: 'pricecompare', heading: '네이버 가격비교', selector: '.price_compare, h2.header-pc-module__title___nqAxd' },
  ];

  for (const section of sections) {
    try {
      const handle = await findSection(page, section.heading, section.selector);
      if (!handle) {
        console.warn(`⚠️ [${keyword}/${viewport.label}] 섹션 '${section.label}'을 찾지 못함`);
      } else {
        const buffer = await handle.screenshot({ encoding: 'binary' });
        const filePath = `${section.label}_${viewport.label}_${keyword}_${timestampLabel}.png`;
        await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        await db.collection('screenshots').add({
          keyword,
          viewport: viewport.label,
          section: section.label,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          filePath,
          url: publicUrl,
        });
      }
    } catch (err) {
      console.error(`🔴 [${keyword}/${viewport.label}/${section.label}] 에러:`, err);
    }
  }

  // 전체 페이지 캡처 (보험용)
  try {
    const fullBuffer = await page.screenshot({ fullPage: true, encoding: 'binary' });
    const fullPath = `fullpage_${viewport.label}_${keyword}_${timestampLabel}.png`;
    await bucket.file(fullPath).save(fullBuffer, { contentType: 'image/png' });
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
    console.error(`🔴 [${keyword}/${viewport.label}/fullpage] 에러:`, err);
  }

  await browser.close();
}

/**
 * 엔트리 포인트
 */
async function main() {
  const keywordsEnv = process.env.KEYWORDS || '';
  const keywords = keywordsEnv.split(',').map(k => k.trim()).filter(Boolean);
  if (!keywords.length) {
    console.error('❌ KEYWORDS 환경변수를 쉼표로 구분해 설정하세요.');
    return;
  }
  const viewports = [
    { label: 'pc',     width: 1366, height: 768 },
    { label: 'mobile', width: 375,  height: 667 },
  ];
  for (const kw of keywords) {
    for (const vp of viewports) {
      await captureKeyword(kw, vp);
    }
  }
}

main().catch(err => console.error('💥 예상치 못한 에러:', err));
```
