// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고 스크린샷 및 전체 페이지 캡처 스크립트
// ✅ 변경점: 기존 루프에서 '모바일-가격비교' 캡처를 제거하고,
//            아래의 전용 함수(clip 기반, 긴 대기+로딩검증)로만 캡처합니다.

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

// ---- 섹션 XPath 정의 (동적 ID 지원) ----
const SECTION_XPATHS = {
  'powerlink-pc':       "//*[starts-with(@id, 'pcPowerLink_')]/div/div",
  'pricecompare-pc':    "//*[@id='shp_gui_root']/section/div[2]",
  'powerlink-mobile':   "//*[starts-with(@id,'mobilePowerLink_')]/section",
  // 'pricecompare-mobile' 는 루프에서 사용하지 않음 (아래 전용 함수 사용)
  'pricecompare-mobile': "//*[@id='shp_tli_root']",
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

// ---- ★ 전용 캡처: 모바일 가격비교(보이는 가로만, 세로 최대) ----
async function captureMobilePricecompareStrict({ page, keyword, viewportLabel, ts }) {
  const containerSelector = '#shp_tli_root';

  // 컨테이너 로딩
  await page.waitForSelector(containerSelector, { timeout: 20000 });

  // 중앙으로 스크롤(실제 렌더링 유도)
  await page.$eval(containerSelector, el => el.scrollIntoView({ block: 'center' }));

  // 충분한 여유 대기 (환경에 따라 느릴 수 있음)
  await delay(20000);

  // 텍스트 채워질 때까지 대기 (내부 글자 수 기준)
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('#shp_tli_root');
      return el && el.innerText && el.innerText.trim().length > 50;
    }, { timeout: 20000 });
  } catch {
    console.warn(`[${keyword}/mobile] pricecompare-mobile: 텍스트 로딩 대기 초과`);
  }

  // 이미지 모두 로딩될 때까지 대기
  await page.evaluate(() => {
    const el = document.querySelector('#shp_tli_root');
    const imgs = Array.from(el.querySelectorAll('img'));
    return Promise.all(
      imgs.map(img =>
        img.complete
          ? Promise.resolve()
          : new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); })
      )
    );
  });

  // 안정화 짧은 대기
  await delay(500);

  // 위치/크기 계산 + 가로는 '보이는 범위'만
  const handle = await page.$(containerSelector);
  const box = await handle.boundingBox();
  if (!box) {
    console.warn(`[${keyword}/mobile] pricecompare-mobile: boundingBox 계산 실패`);
    return;
  }

  const vp = page.viewport();
  const contentHeight = await page.evaluate(() =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  );

  const clip = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.min(Math.floor(box.width), vp.width - Math.max(0, Math.floor(box.x)))),
    height: Math.max(1, Math.min(Math.floor(box.height), contentHeight - Math.max(0, Math.floor(box.y)))),
  };

  // Puppeteer의 전체 페이지 스냅샷에서 clip으로 잘라내기
  const buf = await page.screenshot({ clip, encoding: 'binary' });

  // 업로드 & 기록
  const key = 'pricecompare-mobile';
  const filePath = `${key}_${viewportLabel}_${keyword}_${ts}.png`;
  await bucket.file(filePath).save(buf, { contentType: 'image/png' });
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
  await db.collection('screenshots').add({
    keyword,
    viewport: viewportLabel,
    section: key,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    filePath,
    url: publicUrl,
  });

  console.log(`✅ 모바일 가격비교(전용) 캡처 완료: ${publicUrl}`);
}

// ---- 키워드+뷰포트별 캡처 ----
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', // 탐지 완화
      '--lang=ko-KR',
    ],
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
    await delay(5000);
  } else {
    await delay(2000);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const sectionKeys = [
    'powerlink-pc',
    'pricecompare-pc',
    'powerlink-mobile',
    // 'pricecompare-mobile' 은 여기서 스킵 (아래 전용 함수로 별도 캡처)
  ];

  // 일반 섹션 캡처 루프 (모바일-가격비교 제외)
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

      // 공통: 살짝 콘텐츠 대기
      try {
        await page.waitForXPath(`${xpath}//a`, { timeout: 5000 });
      } catch {}

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

  // ---- 모바일 가격비교: 전용 캡처 실행 ----
  if (viewport.label === 'mobile') {
    try {
      await captureMobilePricecompareStrict({
        page,
        keyword,
        viewportLabel: viewport.label,
        ts,
      });
    } catch (err) {
      console.error(`❗ 에러 [pricecompare-mobile 전용/${viewport.label}/${keyword}]`, err);
    }
  }

  // ---- 전체 페이지 캡처 ----
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
