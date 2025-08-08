```js
// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고(파워링크, 가격비교/쇼핑정보) 스크린샷 스크립트

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// 1) Firebase Admin SDK 초기화
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64')
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  // realtime DB 사용 시 필요하면 아래 주석 해제
  // databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const bucket = admin.storage().bucket();
const db = admin.firestore();

// 2) 섹션 탐색 함수
async function findSection(page, headingTexts) {
  for (const text of headingTexts) {
    // 페이지 전체에서 텍스트 포함 요소 찾기
    const [heading] = await page.$x(`//*[contains(normalize-space(.), '${text}')]`);
    if (!heading) continue;
    // 부모를 올라가며 컨테이너 탐색
    const container = await heading.evaluateHandle(node => {
      let el = node;
      while (el) {
        // 링크가 여러 개 포함된 블록을 컨테이너로 판단
        if (el.querySelectorAll('a').length >= 2) return el;
        el = el.parentElement;
      }
      return null;
    });
    if (container) return container;
  }
  return null;
}

// 3) 캡처 & 업로드 함수
async function captureAndUpload({ keyword, viewport }) {
  const browser = await puppeteer.launch({
    headless: 'new', // 최신 헤드리스 모드 사용
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // 모바일 UA 적용
  if (viewport.label === 'mobile') {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
  }
  await page.setViewport({ width: viewport.width, height: viewport.height });

  // URL 구성 (모바일/PC 분리)
  const baseUrl = viewport.label === 'mobile'
    ? 'https://m.search.naver.com/search.naver?query='
    : 'https://search.naver.com/search.naver?query=';
  const url = baseUrl + encodeURIComponent(keyword);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // 타임스탬프 라벨
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '');

  // 섹션 정의
  const sections = [
    { label: 'powerlink', headings: ['파워링크'] },
    { label: 'shopping', headings: ['가격비교', '네이버 가격비교', '쇼핑정보'] },
  ];

  for (const section of sections) {
    try {
      // 섹션 탐색
      const handle = await findSection(page, section.headings);
      if (!handle) {
        console.warn(`⚠️ [${viewport.label}/${keyword}] ${section.label} 섹션 없음`);
        continue;
      }
      // 스크린샷
      const buffer = await handle.screenshot({ encoding: 'binary' });
      const filePath = `${section.label}_${viewport.label}_${keyword}_${timestamp}.png`;

      // Storage 업로드
      await bucket.file(filePath).save(buffer, { contentType: 'image/png' });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

      // Firestore 메타데이터 기록
      await db.collection('screenshots').add({
        keyword,
        viewport: viewport.label,
        section: section.label,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        filePath,
        url: publicUrl,
      });

      console.log(`✅ [${viewport.label}/${keyword}/${section.label}] ${publicUrl}`);
    } catch (err) {
      console.error(`❌ [${viewport.label}/${keyword}/${section.label}] 에러`, err);
    }
  }

  await browser.close();
}

// 4) 실행 로직
(async () => {
  const keywords = (process.env.KEYWORDS || '').split(',').map(k => k.trim()).filter(k => k);
  const viewports = [
    { label: 'pc', width: 1366, height: 768 },
    { label: 'mobile', width: 375, height: 667 },
  ];

  for (const keyword of keywords) {
    for (const vp of viewports) {
      await captureAndUpload({ keyword, viewport: vp });
    }
  }
})();
```
