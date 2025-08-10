// capture2.js
// 목적: "모바일 네이버 가격검색 섹션"을 여러 방식으로 캡처 → 곧바로 Firebase 업로드
// 실행 예)
//   node capture2.js --keyword "페이퍼팝"
//   KEYWORDS="페이퍼팝,다이슨" node capture2.js
//   node capture2.js --url "https://m.search.naver.com/search.naver?query=..." --dsf 3
//
// 환경변수(Firebase 필수):
//   FIREBASE_SERVICE_ACCOUNT_BASE64  (서비스계정 JSON을 base64로)
//   FIREBASE_PROJECT_ID
//   FIREBASE_STORAGE_BUCKET
//   FIREBASE_DATABASE_URL (선택)
//
// 업로드 관련 옵션:
//   USE_SIGNED_URL=1         -> 업로드 후 signed URL 발급(버킷 비공개 추천)
//   SIGNED_URL_DAYS=7        -> 서명 URL 유효기간(일)
//   CAP_PREFIX="actions/<run_id>"  -> 저장 경로 prefix
//
// 렌더 품질:
//   DEVICE_SCALE_FACTOR=3    -> 1~6 권장

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

let bucket = null;
let db = null;

// ─── Firebase init ──────────────────────────────────────────────
function initFirebase() {
  const admin = require('firebase-admin');
  const sa = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );
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
}

// ─── utils ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dsf = Math.max(1, Math.min(6, parseInt(process.env.DEVICE_SCALE_FACTOR || '3', 10)));
const CAP_PREFIX = (process.env.CAP_PREFIX || '').replace(/^\/+|\/+$/g, '');
const SAVE_DIR = path.join(process.cwd(), 'captures');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '');
}
function slug(s) {
  return (s || '').replace(/[^\w가-힣\-_.]+/g, '_').replace(/_+/g, '_').slice(0, 80);
}

// Firebase 업로드 + URL 반환
async function uploadPNG(buf, { keyword, variant, ts }) {
  const fileName = `pricecompare-mobile_${slug(keyword)}_${ts}_${variant}.png`;
  const gcsPath = CAP_PREFIX ? `${CAP_PREFIX}/${fileName}` : fileName;

  // 로컬도 항상 저장(문제 디버깅용)
  fs.writeFileSync(path.join(SAVE_DIR, fileName), buf);

  await bucket.file(gcsPath).save(buf, { contentType: 'image/png', resumable: false });

  let url;
  if (process.env.USE_SIGNED_URL === '1') {
    const days = Math.max(1, parseInt(process.env.SIGNED_URL_DAYS || '7', 10));
    const expires = Date.now() + days * 24 * 60 * 60 * 1000;
    const [signed] = await bucket.file(gcsPath).getSignedUrl({ action: 'read', expires });
    url = signed;
  } else {
    // 버킷 정책이 허용되면 공개. 실패하면 서명URL로 폴백
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

  await db.collection('screenshots').add({
    keyword,
    viewport: 'mobile',
    section: 'pricecompare-mobile',
    variant,
    filePath: gcsPath,
    url,
    timestamp: new Date(),
  });

  return { url, gcsPath };
}

// ─── browser helpers ────────────────────────────────────────────
async function launchMobile() {
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

async function killAnimations(page) {
  await page.addStyleTag({
    content: `
      *{animation:none!important;transition:none!important}
      *::before,*::after{animation:none!important;transition:none!important}
      [style*="position:sticky"],[style*="position:fixed"]{position:static!important}
      header,footer,nav,[class*="sticky"],[class*="Fixed"],[class*="floating"],[class*="Floating"]{display:none!important}
      body{overscroll-behavior:contain!important}
    `,
  });
}

async function openSearch(page, keywordOrUrl) {
  const isUrl = /^https?:\/\//i.test(keywordOrUrl);
  const url = isUrl
    ? keywordOrUrl
    : `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keywordOrUrl)}`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  // lazy load 유도
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 1200));
    window.scrollTo(0, 0);
  });
  await killAnimations(page);
}

// 가격검색 섹션 탐색(가장 보수적으로)
async function resolvePriceSelector(page) {
  // 1) 고정 루트
  const hasRoot = await page.$('#shp_tli_root');
  if (hasRoot) return '#shp_tli_root';

  // 2) 텍스트 단서(가격/비교/최저가) 포함한 래퍼
  const sel = await page.evaluate(() => {
    // 텍스트 포함 노드 찾기
    const byText = (nodes, rx) =>
      nodes.find((n) => rx.test((n.innerText || '').replace(/\s+/g, ' ').trim()));

    // 후보: 섹션/디비전들
    const cands = [
      ...document.querySelectorAll('section, div, article'),
    ];

    // 흔한 클래스 프리픽스
    const guide = byText(
      Array.from(document.querySelectorAll('[class^="guide-mobile-module__page___"]')),
      /(가격|비교|최저가)/
    );
    if (guide) return makeSel(guide);

    const hit = byText(cands, /(가격|비교|최저가)/);
    return hit ? makeSel(hit) : null;

    function makeSel(el) {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      // 간단 유니크 셀렉터 생성
      const parts = [];
      let cur = el;
      for (let i = 0; cur && i < 5; i++) {
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
  });
  return sel;
}

// 섹션 안정화: 스크롤 + 이미지/폰트 대기
async function stabilize(page, selector, waitMs = 9000) {
  await page.$eval(selector, (el) => el.scrollIntoView({ behavior: 'instant', block: 'center' })).catch(() => {});
  await sleep(200);

  // 이미지 eager + 보이기
  await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return;
    host.querySelectorAll('img').forEach((img) => {
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

  // 텍스트/이미지 로딩 보장 시도
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const okText = (el.innerText || '').trim().length > 30;
        const imgs = Array.from(el.querySelectorAll('img'));
        const okImg = imgs.every((i) => i.complete && i.naturalWidth > 0);
        return okText && okImg;
      },
      { timeout: waitMs },
      selector
    );
  } catch {
    // 그냥 경고만
    console.warn('⚠️  섹션 로딩이 제한 시간 내 완전하지 않음 → 계속 진행');
  }
  await sleep(150);
}

// 섹션 DOMRect → 페이지 좌표 clip
async function getClipFromRect(page, selector, pad = 0) {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.floor((window.scrollX || window.pageXOffset) + r.left),
      y: Math.floor((window.scrollY || window.pageYOffset) + r.top),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height),
      docWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth
      ),
      docHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      ),
    };
  }, selector);
  if (!rect) throw new Error('rect null');

  const clip = {
    x: Math.max(0, rect.x - pad),
    y: Math.max(0, rect.y - pad),
    width: Math.max(1, rect.width + pad * 2),
    height: Math.max(1, rect.height + pad * 2),
  };
  // 문서 경계에 맞춰 클램프
  clip.width = Math.min(clip.width, rect.docWidth - clip.x);
  clip.height = Math.min(clip.height, rect.docHeight - clip.y);
  return clip;
}

// ─── capture variants (안정 순서대로) ───────────────────────────
async function v_rect_clip(page, selector, keyword, ts) {
  const clip = await getClipFromRect(page, selector, 0);
  const buf = await page.screenshot({ clip, type: 'png' });
  const out = await uploadPNG(buf, { keyword, variant: 'rect_clip', ts });
  return { variant: 'rect_clip', ok: true, ...out };
}

async function v_rect_clip_pad(page, selector, keyword, ts) {
  const clip = await getClipFromRect(page, selector, Math.round(8 * dsf));
  const buf = await page.screenshot({ clip, type: 'png' });
  const out = await uploadPNG(buf, { keyword, variant: 'rect_clip_pad', ts });
  return { variant: 'rect_clip_pad', ok: true, ...out };
}

async function v_rect_clip_hidpi(page, selector, keyword, ts) {
  const el = await page.$(selector);
  if (!el) throw new Error('element null');
  const box = await el.boundingBox();
  if (!box) throw new Error('boundingBox failed');

  await page.setViewport({
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
    deviceScaleFactor: Math.min(dsf * 2, 6),
    isMobile: true,
    hasTouch: true,
  });
  const clip = await getClipFromRect(page, selector, 0);
  const buf = await page.screenshot({ clip, type: 'png' });
  const out = await uploadPNG(buf, { keyword, variant: 'rect_clip_hidpi', ts });
  return { variant: 'rect_clip_hidpi', ok: true, ...out };
}

async function v_element_screenshot(page, selector, keyword, ts) {
  // puppeteer의 element.screenshot은 가끔 "not visible" 나서 보조용으로만 사용
  const el = await page.$(selector);
  if (!el) throw new Error('element null');
  const buf = await el.screenshot({ type: 'png' });
  const out = await uploadPNG(buf, { keyword, variant: 'element_screenshot', ts });
  return { variant: 'element_screenshot', ok: true, ...out };
}

async function v_isolated_dom(page, selector, keyword, ts) {
  // 필요한 경우에만(마지막 보조) 시도
  const isoHTML = await page.evaluate(async (sel) => {
    const host = document.querySelector(sel);
    if (!host) return null;
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }

    host.querySelectorAll('img').forEach((img) => {
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

    const cloneWithComputed = (node) => {
      const c = node.cloneNode(false);
      if (node.nodeType === 1) {
        const cs = getComputedStyle(node);
        const style = Array.from(cs).map((p) => `${p}:${cs.getPropertyValue(p)};`).join('');
        c.setAttribute('style', style);
        if (node.tagName === 'IMG' && node.src) c.setAttribute('src', node.src);
      }
      node.childNodes.forEach((ch) => c.appendChild(cloneWithComputed(ch)));
      return c;
    };
    const rect = host.getBoundingClientRect();
    const cloned = cloneWithComputed(host);
    const wrap = document.createElement('div');
    wrap.style.padding = '12px';
    wrap.style.background = '#fff';
    wrap.style.width = rect.width + 'px';
    wrap.appendChild(cloned);

    return `<!doctype html><html lang="ko"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>html,body{margin:0;background:#fff}</style>
    </head><body>${wrap.outerHTML}</body></html>`;
  }, selector);

  if (!isoHTML) throw new Error('isolated html null');

  const iso = await page.browser().newPage();
  await iso.setViewport({ width: 1000, height: 1000, deviceScaleFactor: dsf });
  await iso.setContent(isoHTML, { waitUntil: 'load' });
  await sleep(200);
  const size = await iso.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { w: Math.ceil(b.width), h: Math.ceil(b.height) };
  });
  await iso.setViewport({ width: size.w, height: Math.min(size.h, 2000), deviceScaleFactor: dsf });
  const buf = await iso.screenshot({ clip: { x: 0, y: 0, width: size.w, height: size.h } });
  await iso.close();

  const out = await uploadPNG(buf, { keyword, variant: 'isolated_dom', ts });
  return { variant: 'isolated_dom', ok: true, ...out };
}

// ─── main ───────────────────────────────────────────────────────
async function runOnce(target) {
  initFirebase();
  const { browser, page } = await launchMobile();
  const ts = stamp();
  const isURL = /^https?:\/\//i.test(target);
  const keyword = isURL ? '(viaURL)' : target;

  const results = [];
  try {
    await openSearch(page, target);

    // 섹션 찾기(여러 번 시도)
    let selector = null;
    for (let i = 0; i < 3 && !selector; i++) {
      selector = await resolvePriceSelector(page);
      if (!selector) {
        await sleep(1000);
        await page.evaluate(() => window.scrollBy(0, 600));
      }
    }
    if (!selector) throw new Error('가격검색 섹션 탐지 실패');

    await page.waitForSelector(selector, { timeout: 20000 });
    await stabilize(page, selector, 12000);

    // 안정 순서대로 시도: rect_clip → rect_clip_pad → rect_clip_hidpi → element → isolated
    const tries = [
      v_rect_clip,
      v_rect_clip_pad,
      v_rect_clip_hidpi,
      v_element_screenshot,
      v_isolated_dom,
    ];
    for (const fn of tries) {
      const name = fn.name.replace(/^v_/, '');
      try {
        const r = await fn(page, selector, keyword, ts);
        results.push({ variant: name, ok: true, url: r.url });
        console.log(`🟢 ${name} 업로드 완료 → ${r.url}`);
      } catch (e) {
        results.push({ variant: name, ok: false, error: e.message });
        console.warn(`🔴 ${name} 실패: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('❌ 전체 실패:', e.message);
  } finally {
    await browser.close();
  }

  console.log('──────── 요약 ────────');
  for (const r of results) {
    if (r.ok) console.log(`✅ ${r.variant}: ${r.url}`);
    else console.log(`❌ ${r.variant}: ${r.error}`);
  }
}

// ─── CLI ────────────────────────────────────────────────────────
(function cli() {
  const argv = process.argv.slice(2);
  const getArg = (k, d = null) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };

  const url = getArg('url');
  const keyword = getArg('keyword');
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
      console.log(`\n▶ 실행: ${t}`);
      await runOnce(t);
    }
  })().catch((e) => {
    console.error('UNCAUGHT:', e);
    process.exit(1);
  });
})();
