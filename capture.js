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
 * 헤더 요소를 찾고, 섹션 전체 컨테이너를 반환합니다.
 * containerType에 따라 동적 id 기반 요소나 고정 셀렉터를 사용합니다.
 */
async function findContainer(page, headerSelector, headerText, containerType) {
  let headerHandle = null;
  if (headerSelector) {
    headerHandle = await page.$(headerSelector);
    if (headerHandle && headerText) {
      const txt = await headerHandle.evaluate(node => node.innerText.trim());
      if (!txt.includes(headerText)) {
        await headerHandle.dispose();
        headerHandle = null;
      }
    }
  }
  if (!headerHandle && headerText) {
    const [el] = await page.$x(`//*[contains(normalize-space(), '${headerText}')]`);
    headerHandle = el || null;
  }
  if (!headerHandle) return null;

  let containerHandle = null;
  switch (containerType) {
    case 'powerlink-pc':
      containerHandle = await headerHandle.evaluateHandle(node => node.closest("[id^='pcPowerLink_']"));
      break;
    case 'pricecompare-pc':
      containerHandle = await page.evaluateHandle(() =>
        document.querySelector('#shp_gui_root > section > div:nth-child(2)')
      );
      break;
    case 'powerlink-mobile':
      containerHandle = await headerHandle.evaluateHandle(node => {
        const root = node.closest("[id^='mobilePowerLink_']");
        return root ? root.querySelector('section') : null;
      });
      break;
    case 'pricecompare-mobile':
      containerHandle = await page.evaluateHandle(() =>
        document.getElementById('shp_tli_root')
      );
      break;
  }
  await headerHandle.dispose();
  return containerHandle;
}

// 키워드+뷰포트별 캡처 수행
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
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
  await page.waitForTimeout(2000);

  const ts = new Date().toISOString().replace(/[:.]/g, '');

  const sections = [
    { label: 'powerlink-pc',       sel: 'h2.title',                              text: '파워링크',          type: 'powerlink-pc' },
    { label: 'pricecompare-pc',    sel: 'h2.header-pc-module__title',            text: '네이버 가격비교',  type: 'pricecompare-pc' },
    { label: 'powerlink-mobile',   sel: 'div.title_wrap > span.sub',              text: '관련 광고',        type: 'powerlink-mobile' },
    { label: 'pricecompare-mobile',sel: 'h2.header-mobile-module__title',        text: '네이버 가격비교',  type: 'pricecompare-mobile' },
    { label: 'fullpage',           sel: null,                                     text: null,            type: 'fullpage' },
  ];

  for (const sec of sections) {
    try {
      // 전체 페이지 캡처
      if (sec.type === 'fullpage') {
        const path = `${sec.label}_${viewport.label}_${keyword}_${ts}.png`;
        const buf = await page.screenshot({ fullPage: true });
        await bucket.file(path).save(buf, { contentType: 'image/png' });
        await db.collection('screenshots').add({
          keyword, viewport: viewport.label, section: sec.label,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          filePath: path, url: `https://storage.googleapis.com/${bucket.name}/${path}`
        });
        continue;
      }

      const handle = await findContainer(page, sec.sel, sec.text, sec.type);
      if (!handle) {
        console.warn(`❗ [${keyword}/${viewport.label}/${sec.label}] 섹션 미발견`);
        continue;
      }

      const path = `${sec.label}_${viewport.label}_${keyword}_${ts}.png`;
      const buf = await handle.screenshot({ encoding: 'binary' });
      await bucket.file(path).save(buf, { contentType: 'image/png' });
      await db.collection('screenshots').add({
        keyword, viewport: viewport.label, section: sec.label,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath: path, url: `https://storage.googleapis.com/${bucket.name}/${path}`
      });
      await handle.dispose();
    } catch (e) {
      console.error(`❗ 에러 [${keyword}/${viewport.label}/${sec.label}]`, e);
    }
  }

  await browser.close();
}

// IIFE 실행부
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
```
