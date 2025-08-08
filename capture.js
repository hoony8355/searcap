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

// **findSection**: async 함수임을 선언합니다.
async function findSection(page, headerSelector, headerText) {
  // 1) 우선 headerSelector로 찾아보기
  if (headerSelector) {
    const direct = await page.$(headerSelector);
    if (direct) {
      return direct;
    }
  }

  // 2) XPath로 텍스트 포함 헤더 찾기
  const [heading] = await page.$x(`//${headerSelector || '*'}[contains(normalize-space(), '${headerText}')]`);
  if (!heading) return null;

  // 3) 헤더에서 가장 가까운 section 또는 링크가 2개 이상 있는 부모 요소로 올라가기
  const sectionHandle = await heading.evaluateHandle(node => {
    let el = node;
    // 우선 <section> 태그를 찾고, 없다면 링크 개수로 판단
    while (el) {
      if (el.tagName === 'SECTION') return el;
      if (el.querySelectorAll('a').length >= 2) return el;
      el = el.parentElement;
    }
    return node;
  });
  return sectionHandle;
}

// **captureKeyword**: 이 함수가 async여야 내부 await가 가능
async function captureKeyword(keyword, viewport) {
  // 1) 브라우저 기동
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  // 2) 모바일인 경우 UA 및 모바일 URL 사용
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
  }
  await page.setViewport({ width: viewport.width, height: viewport.height });

  const baseUrl = viewport.label === 'mobile'
    ? 'https://m.search.naver.com/search.naver?query='
    : 'https://search.naver.com/search.naver?query=';

  await page.goto(baseUrl + encodeURIComponent(keyword), { waitUntil: 'domcontentloaded' });
  // 동적 로딩 대기 (간단히 2초)
  await page.waitForTimeout(2000);

  // 캡처 타임스탬프
  const now = new Date();
  const timestampLabel = now.toISOString().replace(/[:.]/g, '');

  // 4개 섹션 + 전체 페이지 섹션 정보
  const sections = [
    { label: 'powerlink',     selector: 'h2.title',                              text: '파워링크' },
    { label: 'pricecompare-pc', selector: 'h2.header-pc-module__title',         text: '네이버 가격비교' },
    { label: 'powerlink-mobile', headerSelector: 'div.title_wrap > span.sub',   text: '관련 광고' },
    { label: 'pricecompare-mobile', headerSelector: 'h2.header-mobile-module__title', text: '네이버 가격비교' },
    { label: 'fullpage',       selector: null,                                  text: null },
  ];

  for (const sec of sections) {
    try {
      let handle;

      if (sec.label === 'fullpage') {
        // 전체 페이지 스크린샷
        const filePath = `fullpage_${viewport.label}_${keyword}_${timestampLabel}.png`;
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

      // 섹션별 handle 얻기
      handle = await findSection(
        page,
        sec.selector || sec.headerSelector,
        sec.text
      );
      if (!handle) {
        console.warn(`❗ [${keyword}/${viewport.label}/${sec.label}] 섹션을 찾지 못했습니다.`);
        continue;
      }

      // 캡처
      const filePath = `${sec.label}_${viewport.label}_${keyword}_${timestampLabel}.png`;
      const buffer = await handle.screenshot({ encoding: 'binary' });
      await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
      const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      // Firestore 기록
      await db.collection('screenshots').add({
        keyword, viewport: viewport.label, section: sec.label,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath, url,
      });
    } catch (err) {
      console.error(`❗ 에러 [${keyword}/${viewport.label}/${sec.label}]:`, err);
    }
  }

  await browser.close();
}

// main IIFE: async 함수를 최상위에서 바로 실행
(async () => {
  const keywordsEnv = process.env.KEYWORDS || '';
  const keywords = keywordsEnv.split(',').map(s => s.trim()).filter(Boolean);
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
