// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고(파워링크, 가격비교/쇼핑정보) 스크린샷 스크립트

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// Firebase Admin SDK 초기화
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64')
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});
const bucket = admin.storage().bucket();
const db = admin.firestore();

// XPath 기반 헤더 탐색 후 섹션 컨테이너 반환
async function findSectionByHeader(page, xpath) {
  const elements = await page.$x(xpath);
  if (!elements || elements.length === 0) return null;
  const header = elements[0];
  const sectionHandle = await header.evaluateHandle(node => {
    let el = node.parentElement;
    while (el) {
      if (el.querySelectorAll('a').length > 1) return el;
      el = el.parentElement;
    }
    return node;
  });
  return sectionHandle;
}

// 키워드·뷰포트별 캡처 함수
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  // 모바일인 경우 iPhone UA 및 모바일 URL 사용
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
    await page.goto(
      `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`,
      { waitUntil: 'domcontentloaded' }
    );
  } else {
    await page.goto(
      `https://search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`,
      { waitUntil: 'domcontentloaded' }
    );
  }
  await page.setViewport({ width: viewport.width, height: viewport.height });

  const timestampLabel = new Date().toISOString().replace(/[:.]/g, '');
  const xpaths = {
    pc: {
      powerlink: `//h2[@class="title" and normalize-space(text())="파워링크"]`,
      pricecompare: `//h2[contains(@class,"header-pc-module__title") and normalize-space(text())="네이버 가격비교"]`,
    },
    mobile: {
      powerlink: `//div[contains(@class,"title_wrap") and .//span[contains(text(),"관련 광고")]]`,
      pricecompare: `//h2[contains(@class,"header-mobile-module__title") and normalize-space(text())="네이버 가격비교"]`,
    },
  };

  for (const section of ['powerlink', 'pricecompare']) {
    try {
      const xpath = xpaths[viewport.label][section];
      const container = await findSectionByHeader(page, xpath);
      if (!container) {
        console.warn(`[${viewport.label}/${keyword}/${section}] 헤더를 찾지 못했습니다.`);
        continue;
      }
      const buffer = await container.screenshot({ encoding: 'binary' });
      const filePath = `${section}_${viewport.label}_${keyword}_${timestampLabel}.png`;
      // Storage 업로드
      await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      // Firestore 메타데이터 기록
      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url: publicUrl,
      });
    } catch (err) {
      console.error(`에러: [${viewport.label}/${keyword}/${section}]`, err);
    }
  }
  await browser.close();
}

// 메인 실행 로직
(async () => {
  const keywords = (process.env.KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean);
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
