// capture2.js
// 목적: 모바일 네이버 '가격검색/가격비교' 섹션을 뷰포트 기반 변형들로 캡처.
// - 과거에 잘 됐던 "뷰포트=섹션크기 + element.screenshot"을 1순위로 시도
// - 추가로 clip 기반/패딩/HiDPI 변형도 순차 시도
// - 실패해도 _debug_fullpage_*.png, _attempts_*.json을 captures/에 남김
//
// 실행 예:
//   node capture2.js --keyword "페이퍼팝"
//   node capture2.js --url "https://m.search.naver.com/search.naver?query=..." --dsf 3
//   KEYWORDS="페이퍼팝,다이슨" DEVICE_SCALE_FACTOR=3 node capture2.js
//
// 필요 패키지: puppeteer (필수), firebase-admin (Firebase 쓰는 경우)
//   npm i puppeteer firebase-admin
//
// 환경변수(Firebase 업로드용 - 선택):
//   FIREBASE_SERVICE_ACCOUNT_BASE64  (서비스 계정 JSON base64)
//   FIREBASE_PROJECT_ID
//   FIREBASE_STORAGE_BUCKET
//   FIREBASE_DATABASE_URL            (선택)
//   DRY_RUN=1                        (Firebase 업로드 생략하고 로컬만 저장)
//
// 기타 옵션 환경변수:
//   DEVICE_SCALE_FACTOR=3            (1~6, 기본 3)
//   USE_SIGNED_URL=1                 (비공개 버킷일 때 서명URL 발급)
//   SIGNED_URL_DAYS=7                (서명URL 유효기간)
//   CAP_PREFIX="actions/<run_id>"    (업로드 경로 prefix)

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

let bucket = null;
let db = null;

// ───────────────── Firebase init (선택) ─────────────────
function initFirebase() {
  if (process.env.DRY_RUN === '1') {
    console.log('ℹ️ DRY_RUN=1 → Firebase 업로드 생략');
    return;
  }
  try {
    const admin = require('firebase-admin');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!raw) {
      console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT_BASE64 미설정 → 로컬 저장만 수행');
      return;
    }
    const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
      });
    }
    bucket = admin.storage().bucket();
    db = admin.firestore();
    console.log(`✅ Firebase 초기화 완료 (bucket=${bucket.name})`);
  } catch (e) {
    console.warn('⚠️ Firebase 초기화 실패 → 로컬 저장만 수행:', e.message);
    bucket = null; db = null;
  }
}

// ───────────────── utils ─────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dsfBase = Math.max(1, Math.min(6, parseInt(process.env.DEVICE_SCALE_FACTOR || '3', 10)));
const CAP_PREFIX = (process.env.CAP_PREFIX || '').replace(/^\/+|\/+$/g, '');
const SAVE_DIR = path.join(process.cwd(), 'captures');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '');
const slug = (s) => (s || '').replace(/[^\w가-힣\-_.]+/g, '_').replace(/_+/g, '_').slice(0, 120);

async function uploadPNG(buf, { keyword, variant, ts }) {
  const fileName = `price-mobile_vp_${slug(keyword)}_${ts}_${variant}.png`;
  const localPath = path.join(SAVE_DIR, fileName);
  fs.writeFileSync(localPath, buf);

  // Firebase 비사용 시 로컬만 반환
  if (!bucket || !db || process.env.DRY_RUN === '1') {
    return { url: `file://${localPath}`, gcsPath: null, localPath };
  }

  // 업로드
  const gcsPath = CAP_PREFIX ? `${CAP_PREFIX}/${fileName}` : fileName;
  try {
    await bucket.file(gcsPath).save(buf, { contentType: 'image/png', resumable: false });
    let url;
    if (process.env.USE_SIGNED_URL === '1') {
      const days = Math.max(1, parseInt(process.env.SIGNED_URL_DAYS || '7', 10));
      const [signed] = await bucket.file(gcsPath).getSignedUrl({
        action: 'read',
        expires: Date.now() + days * 24 * 60 * 60 * 1000,
      });
      url = signed;
    } else {
      try {
        await bucket.file(gcsPath).makePublic();
        url = `https://storage.googleapis.com/${bucket.name}/${gcsPath}`;
      } catch {
        const [signed] = await bucket.file(gcsPath).getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        url = signed;
      }
    }
    // Firestore 로그
    try {
      await db.collection('screenshots').add({
        keyword,
        viewport: 'mobile',
        section: 'pricecompare-mobile',
        variant,
        filePath: gcsPath,
        url,
        ts_iso: new Date().toISOString(),
        timestamp: new Date(),
      });
    } catch (e) {
      console.warn('⚠️ Firestore 기록 실패:', e.message);
    }
    return { url, gcsPath, localPath };
  } catch (e) {
    console.warn('⚠️ Storage 업로드 실패 → 로컬만 유지:', e.message);
    return { url: `file://${localPath}`, gcsPath: null, localPath };
  }
}

// ───────────────── browser setup ─────────────────
async function launchMobile(dsf = dsfBase) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      '--window-size=390,844',
    ],
    defaultViewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: dsf,
      isMobile: true,
      hasTouch: true,
    },
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  );
  return { browser, page };
}

async function killNoise(page) {
  await page.addStyleTag({
    content: `
      *{animation:none!important;transition:none!important}
      *::before,*::after{animation:none!important;transition:none!important}
      [style*="position:sticky"],[style*="position:fixed"]{position:static!important}
      header,footer,nav,[class*="sticky"],[class*="Floating"],[class*="floating"]{display:none!important}
      body{overscroll-behavior:contain!important}
    `,
  });
}

async function openSearch(page, target) {
  const isUrl = /^https?:\/\//i.test(target);
  const url = isUrl
    ? target
    : `https://m.search.naver.com/search.naver?query=${encodeURIComponent(target)}`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  // lazy 유도
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 800));
    window.scrollTo(0, 0);
  });
  await killNoise(page);
}

// 가격검색/가격비교 섹션 탐지
async function resolveSectionSelector(page) {
  // 1) 고정 루트 우선
  const root = await page.$('#shp_tli_root');
  if (root) return '#shp_tli_root';

  // 2) 텍스트 기반 탐지
  const sel = await page.evaluate(() => {
    const hasText = (el) =>
      /(가격검색|가격 비교|가격비교|최저가)/.test((el.innerText || '').replace(/\s+/g, ' '));

    // 헤딩에서 찾기
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,section header,div h2'));
    for (const h of headings) {
      if (hasText(h)) {
        const c = h.closest('section,article,div');
        if (c) return makeSel(c);
      }
    }

    // 그 외 텍스트 포함 컨테이너
    const cands = Array.from(document.querySelectorAll('section,article,div')).filter(hasText);
    if (cands.length) return makeSel(cands[0]);

    function makeSel(el) {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let cur = el;
      for (let i = 0; cur && i < 4; i++) {
        let s = cur.nodeName.toLowerCase();
        if (cur.classList.length) {
          s += '.' + Array.from(cur.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
        }
        const p = cur.parentElement;
        if (p) {
          const sib = Array.from(p.children).filter((x) => x.nodeName === cur.nodeName);
          if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(cur) + 1})`;
        }
        parts.unshift(s);
        cur = p;
      }
      return parts.join(' > ');
    }
    return null;
  });
  return sel;
}

async function stabilizeSection(page, selector, timeoutMs = 12000) {
  await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  await page.$eval(selector, (el) => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await sleep(150);

  // lazy 해제 및 이미지/폰트 로딩
  await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return;
    const imgs = Array.from(host.querySelectorAll('img'));
    imgs.forEach((img) => {
      img.loading = 'eager';
      if (img.srcset) {
        const last = img.srcset.split(',').pop();
        if (last) {
          const u = last.trim().split(' ')[0];
          if (u) img.src = u;
        }
      }
      img.style.visibility = 'visible';
      img.style.opacity = '1';
    });
  }, selector);

  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const okText = (el.innerText || '').trim().length > 30;
        const okImgs = Array.from(el.querySelectorAll('img')).every(
          (i) => i.complete && i.naturalWidth > 0
        );
        return okText && okImgs;
      },
      { timeout: timeoutMs },
      selector
    );
  } catch {
    console.warn('⚠️ 섹션 로딩 완전하지 않음 → 계속 진행');
  }
}

async function getRect(page, selector) {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.floor((window.scrollX || window.pageXOffset) + r.left),
      y: Math.floor((window.scrollY || window.pageYOffset) + r.top),
      w: Math.ceil(r.width),
      h: Math.ceil(r.height),
    };
  }, selector);
  if (!rect) throw new Error('rect null');
  if (rect.w < 40 || rect.h < 40) throw new Error(`rect too small (${rect.w}x${rect.h})`);
  return rect;
}

async function alignToTopLeft(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    window.scrollTo({
      top: (window.scrollY || window.pageYOffset) + r.top,
      left: 0,
      behavior: 'instant',
    });
  }, selector);
  await sleep(100);
}

// ────────────── Viewport 기반 변형들 ──────────────

// 0) 과거 성공 사례 그대로: 섹션 boundingBox → viewport를 그 크기에 맞춤 → element.screenshot
async function vp_bb_viewport_element(page, selector, keyword, ts, dsf = dsfBase) {
  const el = await page.$(selector);
  if (!el) throw new Error('element null');
  const box = await el.boundingBox();
  if (!box) throw new Error('boundingBox null');

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  }, selector);

  await page.setViewport({
    width: Math.max(1, Math.ceil(box.width)),
    height: Math.max(1, Math.ceil(box.height)),
    deviceScaleFactor: dsf,
    isMobile: true,
    hasTouch: true,
  });

  const buf = await el.screenshot({ type: 'png' });
  const out = await uploadPNG(buf, { keyword, variant: 'vp_bb_viewport_element', ts });
  return out;
}

// 1) viewport=섹션 크기, (0,0) clip
async function vp_exact_clip(page, selector, keyword, ts, dsf = dsfBase) {
  const rect = await getRect(page, selector);
  await alignToTopLeft(page, selector);
  await page.setViewport({
    width: Math.max(1, rect.w),
    height: Math.max(1, rect.h),
    deviceScaleFactor: dsf,
    isMobile: true,
    hasTouch: true,
  });
  const buf = await page.screenshot({
    clip: { x: 0, y: 0, width: rect.w, height: rect.h },
    type: 'png',
  });
  return uploadPNG(buf, { keyword, variant: 'vp_exact_clip', ts });
}

// 2) viewport=섹션 크기, element.screenshot
async function vp_exact_element(page, selector, keyword, ts, dsf = dsfBase) {
  const rect = await getRect(page, selector);
  await alignToTopLeft(page, selector);
  await page.setViewport({
    width: Math.max(1, rect.w),
    height: Math.max(1, rect.h),
    deviceScaleFactor: dsf,
    isMobile: true,
    hasTouch: true,
  });
  const el = await page.$(selector);
  if (!el) throw new Error('element null');
  const buf = await el.screenshot({ type: 'png' });
  return uploadPNG(buf, { keyword, variant: 'vp_exact_element', ts });
}

// 3) viewport=(섹션 + pad), (0,0) clip
async function vp_pad_clip(page, selector, keyword, ts, dsf = dsfBase) {
  const rect = await getRect(page, selector);
  const pad = Math.round(8 * dsf);
  await page.evaluate((sel, p) => {
    const el = document.querySelector(sel);
    if (el) el.style.scrollMarginTop = p + 'px';
  }, selector, pad);
  await alignToTopLeft(page, selector);
  await page.setViewport({
    width: rect.w + pad * 2,
    height: rect.h + pad * 2,
    deviceScaleFactor: dsf,
    isMobile: true,
    hasTouch: true,
  });
  const buf = await page.screenshot({
    clip: { x: 0, y: 0, width: rect.w + pad * 2, height: rect.h + pad * 2 },
    type: 'png',
  });
  return uploadPNG(buf, { keyword, variant: 'vp_pad_clip', ts });
}

// 4) viewport=섹션 크기, DSF*2 (HiDPI)
async function vp_hidpi_clip(page, selector, keyword, ts, dsf = dsfBase) {
  const rect = await getRect(page, selector);
  await alignToTopLeft(page, selector);
  await page.setViewport({
    width: Math.max(1, rect.w),
    height: Math.max(1, rect.h),
    deviceScaleFactor: Math.min(dsf * 2, 6),
    isMobile: true,
    hasTouch: true,
  });
  const buf = await page.screenshot({
    clip: { x: 0, y: 0, width: rect.w, height: rect.h },
    type: 'png',
  });
  return uploadPNG(buf, { keyword, variant: 'vp_hidpi_clip', ts });
}

// ───────────────── main ─────────────────
async function runOnce(target, dsf = dsfBase) {
  initFirebase();
  const { browser, page } = await launchMobile(dsf);
  const ts = stamp();
  const isURL = /^https?:\/\//i.test(target);
  const keyword = isURL ? '(viaURL)' : target;

  const results = [];
  try {
    await openSearch(page, target);

    // 섹션 탐지 재시도
    let selector = null;
    for (let i = 0; i < 5 && !selector; i++) {
      selector = await resolveSectionSelector(page);
      if (!selector) {
        await sleep(600);
        await page.evaluate(() => window.scrollBy(0, 700));
      }
    }
    if (!selector) throw new Error('가격검색/가격비교 섹션 탐지 실패');

    await stabilizeSection(page, selector, 12000);

    // 뷰포트 기반 변형들: 과거 성공 방식 먼저
    const flow = [
      ['vp_bb_viewport_element', vp_bb_viewport_element], // ← 1순위
      ['vp_exact_clip',          vp_exact_clip],
      ['vp_exact_element',       vp_exact_element],
      ['vp_pad_clip',            vp_pad_clip],
      ['vp_hidpi_clip',          vp_hidpi_clip],
    ];

    for (const [name, fn] of flow) {
      try {
        const r = await fn(page, selector, keyword, ts, dsf);
        results.push({ variant: name, ok: true, url: r.url });
        console.log(`🟢 ${name} 업로드/저장 완료 → ${r.url}`);
      } catch (e) {
        results.push({ variant: name, ok: false, error: e.message });
        console.warn(`🔴 ${name} 실패: ${e.message}`);
      }
    }

    // 디버그: 전체 페이지 캡처
    try {
      const dbg = await page.screenshot({ fullPage: true });
      const dbgPath = path.join(SAVE_DIR, `_debug_fullpage_${slug(keyword)}_${ts}.png`);
      fs.writeFileSync(dbgPath, dbg);
      console.log(`📝 디버그 fullpage 저장: ${dbgPath}`);
    } catch (e) {
      console.warn('⚠️ 디버그 fullpage 저장 실패:', e.message);
    }

    // 디버그: 시도 결과 JSON
    try {
      const attemptsPath = path.join(SAVE_DIR, `_attempts_${slug(keyword)}_${ts}.json`);
      fs.writeFileSync(attemptsPath, JSON.stringify(results, null, 2));
      console.log(`📝 시도 결과 JSON 저장: ${attemptsPath}`);
    } catch (e) {
      console.warn('⚠️ 시도 결과 JSON 저장 실패:', e.message);
    }
  } catch (e) {
    console.error('❌ 전체 실패:', e.message);
    // 실패해도 디버그 파일 남기기 시도
    try {
      const dbg = await page.screenshot({ fullPage: true });
      const dbgPath = path.join(SAVE_DIR, `_debug_fullpage_FAIL_${slug(keyword)}_${ts}.png`);
      fs.writeFileSync(dbgPath, dbg);
      console.log(`📝 디버그 fullpage(FAIL) 저장: ${dbgPath}`);
    } catch {}
  } finally {
    await browser.close();
  }

  console.log('──────── 요약 ────────');
  for (const r of results) {
    if (r.ok) console.log(`✅ ${r.variant}: ${r.url}`);
    else console.log(`❌ ${r.variant}: ${r.error}`);
  }
}

// ───────────────── CLI ─────────────────
(function cli() {
  const argv = process.argv.slice(2);
  const getArg = (k, d = null) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const url = getArg('url');
  const keyword = getArg('keyword');
  const dsfArg = parseInt(getArg('dsf') || process.env.DEVICE_SCALE_FACTOR || `${dsfBase}`, 10);
  const dsf = Math.max(1, Math.min(6, isNaN(dsfArg) ? dsfBase : dsfArg));

  const envList = (process.env.KEYWORDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const targets = url ? [url] : keyword ? [keyword] : envList;
  if (!targets.length) {
    console.error('사용법) --keyword "검색어" 또는 --url "모바일 검색 URL" 또는 KEYWORDS="키1,키2"');
    process.exit(1);
  }

  (async () => {
    for (const t of targets) {
      console.log(`\n▶ 실행: ${t} (dsf=${dsf})`);
      await runOnce(t, dsf);
    }
  })().catch((e) => {
    console.error('UNCAUGHT:', e);
    process.exit(1);
  });
})();
