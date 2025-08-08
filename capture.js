// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고 스크린샷 및 전체 페이지 캡처 스크립트

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

// 섹션별 XPath 셀렉터 (동적 ID 대응)
const SECTION_XPATHS = {
  'powerlink-pc': '//*[starts-with(@id, "pcPowerLink_")]/div/div',
  'pricecompare-pc': '//*[@id="shp_gui_root"]/section/div[2]',
  'powerlink-mobile': '//*[starts-with(@id, "mobilePowerLink_")]/section',
  'pricecompare-mobile': '//*[@id="shp_tli_root"]',
};

// 주어진 XPath를 이용해 요소 핸들 얻기
async function getByXPath(page, xpath) {
  const handles = await page.$x(xpath);
  return handles[0] || null;
}

// 키워드 + 뷰포트별 캡처 함수
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  // 모바일 UA 설정 및 도메인 분기
  const baseUrl = viewport.label === 'mobile'
    ? 'https://m.search.naver.com/search.naver?query='
    : 'https://search.naver.com/search.naver?query=';
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
  }
  await page.setViewport({ width: viewport.width, height: viewport.height });

  // 페이지 로드 및 대기
  await page.goto(baseUrl + encodeURIComponent(keyword), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const timestampLabel = new Date().toISOString().replace(/[:.]/g, '');

  // 섹션 목록과 fullpage 정의
  const sections = [
    'powerlink-pc',
    'pricecompare-pc',
    'powerlink-mobile',
    'pricecompare-mobile',
    'fullpage',
  ];

  for (const sectionKey of sections) {
    try {
      let buffer, filePath;
      if (sectionKey === 'fullpage') {
        // 전체 페이지 캡처
        buffer = await page.screenshot({ fullPage: true });
        filePath = `${sectionKey}_${viewport.label}_${keyword}_${timestampLabel}.png`;
      } else {
        // XPath로 섹션 컨테이너 찾기
        const xpath = SECTION_XPATHS[sectionKey];
        const handle = await getByXPath(page, xpath);
        if (!handle) {
          console.warn(`❗섹션 미발견: ${sectionKey}`);
          continue;
        }
        buffer = await handle.screenshot({ encoding: 'binary' });
        filePath = `${sectionKey}_${viewport.label}_${keyword}_${timestampLabel}.png`;
      }

      // Firebase Storage 업로드
      await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
      const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      // Firestore 메타데이터 기록
      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section: sectionKey,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url,
      });
    } catch (err) {
      console.error(`❗에러 [${sectionKey}/${viewport.label}/${keyword}]`, err);
    }
  }

  await browser.close();
}

// 실행 진입점
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
