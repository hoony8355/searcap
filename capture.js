// capture.js
// Puppeteer + Firebase를 이용한 네이버 검색 광고 스크린샷 및 전체 페이지 캡처 스크립트
// ✅ 변경점(모바일-가격비교 전용 교체):
//   - 안정화 절차 강화: 애니메이션/트랜지션/Sticky 제거, 폰트/이미지 로딩 대기, lazy 강제
//   - 섹션 감지 보강: #shp_tli_root 우선 + fallback 셀렉터/키워드
//   - 캡처 전략: 뷰포트=섹션크기(clip 기반), 패딩 캡처, HiDPI, 실패 시 고립 렌더(인라인 스타일 복제) fallback
//   - Puppeteer 스크린샷은 Buffer 반환이므로 encoding 옵션 제거(기본 Buffer)
//   - headless: true (최신 Puppeteer 권장), deviceScaleFactor 설정 가능 (ENV)

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

// ---- 유틸 ----
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const envDSF = Math.max(1, parseInt(process.env.DEVICE_SCALE_FACTOR || '3', 10));

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

// ---- 페이지 안정화: 애니메이션·Sticky 제거 ----
async function disableAnimationsAndSticky(page) {
  await page.addStyleTag({
    content: `
      * { animation: none !important; transition: none !important; }
      *::before, *::after { animation: none !important; transition: none !important; }
      [style*="position: sticky"], [style*="position:fixed"] { position: static !important; }
      header, footer, nav, [class*="sticky"], [class*="Fixed"], [class*="floating"], [class*="Floating"] { display: none !important; }
      body { overscroll-behavior: contain !important; }
    `,
  });
}

// ---- 모바일 페이지 준비: 헤딩 대기 + lazy-load 트리거 ----
async function prepareMobilePage(page) {
  try {
    await page.waitForXPath(
      "//h2[contains(normalize-space(), '관련 광고') or contains(normalize-space(),'가격비교')]",
      { timeout: 10000 }
    );
  } catch {}
  // 아래로 끝까지 내려 lazy 로딩 트리거 → 다시 올라오기
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 1500));
    window.scrollTo(0, 0);
  });
}

// ---- 내부 이미지·폰트 로딩 대기 ----
async function waitInnerAssets(page, rootSelector, timeout = 7000) {
  // 이미지 eager + srcset 고정
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.querySelectorAll('img').forEach(img => {
      img.loading = 'eager';
      if (img.srcset) {
        const last = img.srcset.split(',').pop();
        if (last) {
          const url = last.trim().split(' ')[0];
          if (url) img.src = url;
        }
      }
      img.style.visibility = 'visible';
      img.style.opacity = '1';
    });
  }, rootSelector);

  // 폰트
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}

  // 이미지 완료 대기
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const imgs = el.querySelectorAll('img');
        return Array.from(imgs).every(img => img.complete && img.naturalWidth > 0);
      },
      { timeout },
      rootSelector
    );
  } catch {
    console.warn(`[waitInnerAssets] 이미지 로딩 대기 초과: ${rootSelector}`);
  }
}

// ---- 모바일 가격비교 컨테이너 탐색(우선: #shp_tli_root, 보조: 키워드/패턴) ----
async function resolveMobilePricecompareSelector(page) {
  // 우선 셀렉터
  const primary = '#shp_tli_root';
  const hasPrimary = await page.$(primary);
  if (hasPrimary) return primary;

  // 보조: 텍스트 키워드 + 구조 패턴
  const altSel = await page.evaluate(() => {
    // module page 래퍼들
    const nodes = Array.from(document.querySelectorAll('[class^="guide-mobile-module__page___"]'));
    const byKeyword = nodes.find(n => /가격|가격비교|최저가/.test(n.innerText || ''));
    if (byKeyword) return getUniqueSelector(byKeyword);

    // 쇼핑/상품/가격 패턴
    const fallbacks = [
      ...Array.from(document.querySelectorAll('[id*="shp_"]')),
      ...Array.from(document.querySelectorAll('[class*="product"]')),
      ...Array.from(document.querySelectorAll('[class*="price"]')),
    ];
    const hit = fallbacks.find(n => /가격|최저가|비교/.test(n.innerText || ''));
    return hit ? getUniqueSelector(hit) : null;

    // 매우 단순한 unique selector 생성기
    function getUniqueSelector(el) {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 5) {
        let sel = cur.nodeName.toLowerCase();
        if (cur.classList.length) sel += '.' + Array.from(cur.classList).slice(0,2).map(c => CSS.escape(c)).join('.');
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(ch => ch.nodeName === cur.nodeName);
          if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur)+1})`;
        }
        parts.unshift(sel);
        cur = parent;
      }
      return parts.length ? parts.join(' > ') : null;
    }
  });
  return altSel || null;
}

// ---- ★ 전용 캡처: 모바일 가격비교(뷰포트=섹션크기, 여러 변형 + fallback) ----
async function captureMobilePricecompareStrict({ page, keyword, viewportLabel, ts }) {
  // 1) 섹션 찾기
  const selector = await resolveMobilePricecompareSelector(page);
  if (!selector) {
    console.warn(`[${keyword}/mobile] pricecompare-mobile: 섹션 선택자 미발견`);
    return;
  }
  await page.waitForSelector(selector, { timeout: 20000 });

  // 2) 안정화
  await page.$eval(selector, el => el.scrollIntoView({ block: 'center' }));
  await delay(400);
  await waitInnerAssets(page, selector, 8000);

  // 3) 텍스트 최소 보장
  try {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return el && el.innerText && el.innerText.trim().length > 40;
    }, { timeout: 7000 }, selector);
  } catch {
    console.warn(`[${keyword}/mobile] pricecompare-mobile: 텍스트 로딩 대기 초과`);
  }

  // 4) 캡처 시도 세트
  const el = await page.$(selector);
  const box = el ? await el.boundingBox() : null;
  if (!box) {
    console.warn(`[${keyword}/mobile] pricecompare-mobile: boundingBox 계산 실패`);
    return;
  }

  // 파일 저장 유틸
  async function uploadShot(buf, tag) {
    const key = 'pricecompare-mobile';
    const filePath = `${key}_${viewportLabel}_${keyword}_${ts}${tag ? '_' + tag : ''}.png`;
    await bucket.file(filePath).save(buf, { contentType: 'image/png' });
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    await db.collection('screenshots').add({
      keyword,
      viewport: viewportLabel,
      section: key,
      variant: tag || 'base',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      filePath,
      url: publicUrl,
    });
    console.log(`✅ 모바일 가격비교 캡처 완료(${tag || 'base'}): ${publicUrl}`);
  }

  // 공통: 애니메이션/Sticky 억제
  await disableAnimationsAndSticky(page);

  // ── M4-1: 뷰포트=요소 크기 정석
  try {
    await page.setViewport({
      width: Math.max(1, Math.ceil(box.width)),
      height: Math.max(1, Math.ceil(box.height)),
      deviceScaleFactor: envDSF,
      isMobile: true,
      hasTouch: true,
    });
    await el.screenshot().then(uploadShot.bind(null, undefined), async (buf) => uploadShot(buf, '04_viewport'));
  } catch (e) {
    try {
      const buf = await el.screenshot();
      await uploadShot(buf, '04_viewport');
    } catch (err) {
      console.warn('🔴 [M4-1] 실패:', err.message);
    }
  }

  // ── M4-2: clip 패딩
  try {
    const pad = Math.round(8 * envDSF);
    await page.setViewport({
      width: Math.max(1, Math.ceil(box.width + pad * 2)),
      height: Math.max(1, Math.ceil(box.height + pad * 2)),
      deviceScaleFactor: envDSF,
      isMobile: true,
      hasTouch: true,
    });
    await page.evaluate((sel, p) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + r.top - p, left: 0, behavior: 'instant' });
    }, selector, pad);
    await delay(150);
    const fresh = await el.boundingBox();
    const clip = {
      x: Math.max(fresh.x - pad, 0),
      y: Math.max(fresh.y - pad, 0),
      width: fresh.width + pad * 2,
      height: fresh.height + pad * 2,
    };
    const buf = await page.screenshot({ clip });
    await uploadShot(buf, '04_viewport_pad');
  } catch (e) {
    console.warn('🔴 [M4-2] 실패:', e.message);
  }

  // ── M4-3: HiDPI
  try {
    const hidpi = Math.min(envDSF * 2, 6);
    await page.setViewport({
      width: Math.max(1, Math.ceil(box.width)),
      height: Math.max(1, Math.ceil(box.height)),
      deviceScaleFactor: hidpi,
      isMobile: true,
      hasTouch: true,
    });
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), selector);
    await delay(150);
    const buf = await el.screenshot();
    await uploadShot(buf, '04_viewport_hidpi');
  } catch (e) {
    console.warn('🔴 [M4-3] 실패:', e.message);
  }

  // ── Fallback: 고립 렌더(인라인 스타일 복제 → 새 탭)
  try {
    const isoHTML = await page.evaluate(async (sel) => {
      const host = document.querySelector(sel);
      if (!host) return null;

      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }

      // 이미지 eager & srcset 정리
      host.querySelectorAll('img').forEach(img => {
        img.loading = 'eager';
        if (img.srcset) {
          const last = img.srcset.split(',').pop();
          if (last) {
            const url = last.trim().split(' ')[0];
            if (url) img.src = url;
          }
        }
        img.style.visibility = 'visible';
        img.style.opacity = '1';
      });

      const cloneWithComputed = (node) => {
        const clone = node.cloneNode(false);
        if (node.nodeType === 1) {
          const cs = getComputedStyle(node);
          const style = Array.from(cs).map(p => `${p}:${cs.getPropertyValue(p)};`).join('');
          clone.setAttribute('style', style);
          if (node.tagName === 'IMG' && node.src) clone.setAttribute('src', node.src);
        }
        node.childNodes.forEach(ch => clone.appendChild(cloneWithComputed(ch)));
        return clone;
      };

      const rect = host.getBoundingClientRect();
      host.style.width = rect.width + 'px';

      const cloned = cloneWithComputed(host);
      const wrap = document.createElement('div');
      wrap.style.padding = '12px';
      wrap.style.background = '#fff';
      wrap.style.width = rect.width + 'px';
      wrap.appendChild(cloned);

      return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#fff}</style>
</head><body>${wrap.outerHTML}</body></html>`;
    }, selector);

    if (isoHTML) {
      const iso = await page.browser().newPage();
      await iso.setViewport({
        width: Math.max(1, Math.ceil(box.width) + 24),
        height: Math.max(1, Math.ceil(box.height) + 24),
        deviceScaleFactor: envDSF,
      });
      await iso.setContent(isoHTML, { waitUntil: 'load' });
      try { await iso.evaluate(() => document.fonts && document.fonts.ready); } catch {}
      await delay(200);
      const bodyBox = await iso.evaluate(() => {
        const b = document.body.getBoundingClientRect();
        return { width: Math.ceil(b.width), height: Math.ceil(b.height) };
      });
      const buf = await iso.screenshot({ clip: { x: 0, y: 0, width: bodyBox.width, height: bodyBox.height } });
      await iso.close();
      await uploadShot(buf, '04_isolated');
    }
  } catch (e) {
    console.warn('🔴 [fallback isolated] 실패:', e.message);
  }
}

// ---- 키워드+뷰포트별 캡처 ----
async function captureKeyword(keyword, viewport) {
  const browser = await puppeteer.launch({
    headless: true, // 최신 Puppeteer 권장
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', // 탐지 완화
      '--lang=ko-KR',
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    defaultViewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: envDSF,
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

  // 안정화 공통
  await disableAnimationsAndSticky(page);

  if (viewport.label === 'mobile') {
    await prepareMobilePage(page);
    await delay(1200);
  } else {
    await delay(600);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '');

  // 일반 섹션 캡처 루프 (모바일-가격비교 제외)
  const sectionKeys = [
    'powerlink-pc',
    'pricecompare-pc',
    'powerlink-mobile',
    // 'pricecompare-mobile' 은 스킵 → 아래 전용 함수로 처리
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

      // 살짝 콘텐츠 대기
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
      console.log(`✅ 일반 섹션 캡처: ${key} → ${publicUrl}`);
    } catch (err) {
      console.error(`❗ 에러 [${key}/${viewport.label}/${keyword}]`, err.message);
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
      console.error(`❗ 에러 [pricecompare-mobile 전용/${viewport.label}/${keyword}]`, err.message);
    }
  }

  // ---- 전체 페이지 캡처 ----
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
