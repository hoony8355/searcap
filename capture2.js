// capture2.js
// 목적: 모바일(네이버) 가격검색 섹션만 다중 방식으로 빠르게 캡처 & 업로드 테스트
// 실행 예:
//   KEYWORDS="페이퍼팝" node capture2.js
//   node capture2.js --keyword "페이퍼팝"
//   node capture2.js --url "https://m.search.naver.com/search.naver?query=..." --dsf 3
//
// 환경변수(Firebase):
//   FIREBASE_SERVICE_ACCOUNT_BASE64  (필수; service account JSON을 base64 인코딩한 문자열)
//   FIREBASE_PROJECT_ID
//   FIREBASE_STORAGE_BUCKET
//   FIREBASE_DATABASE_URL (선택)
// 선택 환경변수:
//   DEVICE_SCALE_FACTOR=3
//   CAP_PREFIX="devtest/"   (업로드 경로 prefix)
//   DRY_RUN=1               (업로드/DB 기록 생략하고 로컬 저장만)

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ───────────────── Firebase ─────────────────
let bucket = null;
let db = null;

function initFirebase() {
  if (process.env.DRY_RUN) {
    console.log('⚠️  DRY_RUN 모드: 업로드/DB 기록은 생략됩니다.');
    return;
  }
  const admin = require('firebase-admin');
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  });
  bucket = admin.storage().bucket();
  db = admin.firestore();
}

// ───────────────── 공통 유틸 ─────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return (s || '')
    .replace(/[^\w가-힣\-_.]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '');
}

const envDSF = Math.max(1, parseInt(process.env.DEVICE_SCALE_FACTOR || '3', 10));
const CAP_PREFIX = (process.env.CAP_PREFIX || '').replace(/^\/+|\/+$/g, '');
const SAVE_DIR = path.join(process.cwd(), 'captures');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR);

// 업로드(+DB기록) 또는 로컬저장
async function persistImage(buf, { keyword, variant, ts }) {
  const baseName = `pricecompare-mobile_${slug(keyword)}_${ts}_${variant}.png`;
  const gcsPath = CAP_PREFIX ? `${CAP_PREFIX}/${baseName}` : baseName;

  // 로컬 저장(항상)
  const localPath = path.join(SAVE_DIR, baseName);
  try { fs.writeFileSync(localPath, buf); } catch {}

  if (process.env.DRY_RUN) {
    return { localPath, url: null };
  }

  await bucket.file(gcsPath).save(buf, { contentType: 'image/png', resumable: false });
  // 필요 시 공개
  // await bucket.file(gcsPath).makePublic();
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${gcsPath}`;
  await db.collection('screenshots').add({
    keyword,
    viewport: 'mobile',
    section: 'pricecompare-mobile',
    variant,
    timestamp: new Date(),
    filePath: gcsPath,
    url: publicUrl,
  });
  return { localPath, url: publicUrl };
}

// ───────────────── Puppeteer 준비 ─────────────────
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
      deviceScaleFactor: envDSF,
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

async function disableAnimationsAndSticky(page) {
  await page.addStyleTag({
    content: `
      * { animation: none !important; transition: none !important; }
      *::before, *::after { animation: none !important; transition: none !important; }
      [style*="position: sticky"], [style*="position:fixed"] { position: static !important; }
      header, footer, nav, [class*="sticky"], [class*="Fixed"], [class*="floating"], [class*="Floating"] { display:none !important; }
      body { overscroll-behavior: contain !important; }
    `,
  });
}

// 섹션 선택자 찾기: #shp_tli_root 우선 + 키워드/패턴 보조
async function resolvePriceSectionSelector(page) {
  const sel = await page.evaluate(() => {
    const primary = document.querySelector('#shp_tli_root');
    if (primary) return '#shp_tli_root';

    // 가이드 모듈 페이지 래퍼들 중 "가격/최저가/비교" 텍스트가 포함된 것
    const nodes = Array.from(document.querySelectorAll('[class^="guide-mobile-module__page___"]'));
    const hit1 = nodes.find((n) => /가격|최저가|비교/.test((n.innerText || '').trim()));
    if (hit1) return getUniqueSelector(hit1);

    // 기타 패턴
    const cands = [
      ...Array.from(document.querySelectorAll('[id*="shp_"]')),
      ...Array.from(document.querySelectorAll('[class*="price"]')),
      ...Array.from(document.querySelectorAll('[class*="product"]')),
    ];
    const hit2 = cands.find((n) => /가격|최저가|비교/.test((n.innerText || '').trim()));
    return hit2 ? getUniqueSelector(hit2) : null;

    function getUniqueSelector(el) {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let cur = el;
      while (cur && parts.length < 5) {
        let sel = cur.nodeName.toLowerCase();
        if (cur.classList.length) {
          sel += '.' + Array.from(cur.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
        }
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((ch) => ch.nodeName === cur.nodeName);
          if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
        parts.unshift(sel);
        cur = parent;
      }
      return parts.join(' > ');
    }
  });
  return sel;
}

async function preparePage(page, urlOrKeyword) {
  const isURL = /^https?:\/\//i.test(urlOrKeyword);
  const url = isURL
    ? urlOrKeyword
    : `https://m.search.naver.com/search.naver?query=${encodeURIComponent(urlOrKeyword)}`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(async (e) => {
    console.error('❌ 페이지 오픈 실패:', e.message);
    throw e;
  });

  // lazy 로딩 트리거
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 1200));
    window.scrollTo(0, 0);
  });
  await disableAnimationsAndSticky(page);
}

// 이미지/폰트 로딩 대기 + lazy 강제
async function stabilizeSection(page, selector, timeout = 8000) {
  await page.$eval(selector, (el) => el.scrollIntoView({ behavior: 'instant', block: 'center' })).catch(() => {});
  await sleep(200);

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
      { timeout },
      selector
    );
  } catch {
    console.warn('⚠️  섹션 자산 로딩이 제한 시간 내 완료되지 않았습니다. 계속 진행합니다.');
  }
  await sleep(150);
}

// ───────────────── 캡처 방식들 ─────────────────
// 결과형: { variant, ok, url, localPath, error }

async function m_viewport_element(page, selector, keyword, ts) {
  const el = await page.$(selector);
  if (!el) throw new Error('element not found');
  const box = await el.boundingBox();
  if (!box) throw new Error('boundingBox failed');

  await page.setViewport({
    width: Math.max(1, Math.ceil(box.width)),
    height: Math.max(1, Math.ceil(box.height)),
    deviceScaleFactor: envDSF,
    isMobile: true,
    hasTouch: true,
  });
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), selector);
  await sleep(120);

  const buf = await el.screenshot();
  const out = await persistImage(buf, { keyword, variant: 'viewport', ts });
  return { variant: 'viewport', ok: true, ...out };
}

async function m_viewport_pad(page, selector, keyword, ts) {
  const el = await page.$(selector);
  const box = await el.boundingBox();
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
  await sleep(150);

  const fresh = await el.boundingBox();
  const clip = {
    x: Math.max(fresh.x - pad, 0),
    y: Math.max(fresh.y - pad, 0),
    width: Math.ceil(fresh.width + pad * 2),
    height: Math.ceil(fresh.height + pad * 2),
  };
  const buf = await page.screenshot({ clip });
  const out = await persistImage(buf, { keyword, variant: 'viewport_pad', ts });
  return { variant: 'viewport_pad', ok: true, ...out };
}

async function m_hidpi(page, selector, keyword, ts) {
  const el = await page.$(selector);
  const box = await el.boundingBox();
  const hidpi = Math.min(envDSF * 2, 6);

  await page.setViewport({
    width: Math.max(1, Math.ceil(box.width)),
    height: Math.max(1, Math.ceil(box.height)),
    deviceScaleFactor: hidpi,
    isMobile: true,
    hasTouch: true,
  });
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), selector);
  await sleep(150);

  const buf = await el.screenshot();
  const out = await persistImage(buf, { keyword, variant: 'hidpi', ts });
  return { variant: 'hidpi', ok: true, ...out };
}

async function m_flatten(page, selector, keyword, ts) {
  const el = await page.$(selector);
  await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return;
    host.style.transform = 'none';
    host.style.filter = 'none';
    host.style.position = 'static';
    host.style.willChange = 'auto';
    host.style.contain = 'none';
    host.querySelectorAll('*').forEach((n) => {
      const cs = getComputedStyle(n);
      if (cs.position === 'sticky' || cs.position === 'fixed') n.style.position = 'static';
      if (cs.transform && cs.transform !== 'none') n.style.transform = 'none';
      if (cs.filter && cs.filter !== 'none') n.style.filter = 'none';
      if (cs.willChange) n.style.willChange = 'auto';
    });
  }, selector);
  await sleep(120);

  const buf = await el.screenshot();
  const out = await persistImage(buf, { keyword, variant: 'flatten', ts });
  return { variant: 'flatten', ok: true, ...out };
}

async function m_isolated(page, selector, keyword, ts) {
  // 섹션을 computed style로 인라인 복제 → about:blank 탭에서 렌더 후 캡처
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
      const clone = node.cloneNode(false);
      if (node.nodeType === 1) {
        const cs = getComputedStyle(node);
        const style = Array.from(cs).map((p) => `${p}:${cs.getPropertyValue(p)};`).join('');
        clone.setAttribute('style', style);
        if (node.tagName === 'IMG' && node.src) clone.setAttribute('src', node.src);
      }
      node.childNodes.forEach((ch) => clone.appendChild(cloneWithComputed(ch)));
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

  if (!isoHTML) throw new Error('isolated: html null');

  const iso = await page.browser().newPage();
  const el = await page.$(selector);
  const box = await el.boundingBox();
  await iso.setViewport({
    width: Math.max(1, Math.ceil(box.width) + 24),
    height: Math.max(1, Math.ceil(box.height) + 24),
    deviceScaleFactor: envDSF,
  });
  await iso.setContent(isoHTML, { waitUntil: 'load' });
  try { await iso.evaluate(() => document.fonts && document.fonts.ready); } catch {}
  await sleep(200);

  const bodyRect = await iso.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { width: Math.ceil(b.width), height: Math.ceil(b.height) };
  });
  const buf = await iso.screenshot({ clip: { x: 0, y: 0, width: bodyRect.width, height: bodyRect.height } });
  await iso.close();

  const out = await persistImage(buf, { keyword, variant: 'isolated', ts });
  return { variant: 'isolated', ok: true, ...out };
}

// ───────────────── 실행 메인 ─────────────────
async function runOnce({ keywordOrUrl }) {
  initFirebase();

  const { browser, page } = await launchMobile();
  const ts = nowStamp();
  const kw = /^https?:\/\//i.test(keywordOrUrl) ? '(viaURL)' : keywordOrUrl;

  const results = [];

  try {
    await preparePage(page, keywordOrUrl);
    const selector = await resolvePriceSectionSelector(page);
    if (!selector) throw new Error('가격검색 섹션 선택자 탐지 실패');

    await page.waitForSelector(selector, { timeout: 20000 });
    await stabilizeSection(page, selector, 9000);

    // 빠른 멀티 트라이(순서 중요: 가장 가벼운 것부터)
    const runners = [
      m_viewport_element,
      m_viewport_pad,
      m_hidpi,
      m_flatten,
      m_isolated,
    ];

    for (const fn of runners) {
      const name = fn.name.replace(/^m_/, '');
      try {
        const r = await fn(page, selector, kw, ts);
        results.push({ variant: name, ok: true, url: r.url, localPath: r.localPath });
        console.log(`🟢 ${name} 완료 → ${r.url || r.localPath}`);
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

  // 요약
  console.log('──────── 요약 ────────');
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ ${r.variant}: ${r.url || r.localPath}`);
    } else {
      console.log(`❌ ${r.variant}: ${r.error}`);
    }
  }
}

// ───────────────── CLI 파서 ─────────────────
(function cli() {
  const argv = process.argv.slice(2);
  const getArg = (name, alt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : alt;
  };

  let keyword = getArg('keyword', null);
  const url = getArg('url', null);
  const envKeywords = (process.env.KEYWORDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let targetList = [];
  if (url) targetList = [url];
  else if (keyword) targetList = [keyword];
  else if (envKeywords.length > 0) targetList = envKeywords;
  else {
    console.error('사용법: --keyword "검색어" 또는 --url "모바일 검색 URL" 또는 KEYWORDS="키워드1,키워드2"');
    process.exit(1);
  }

  (async () => {
    for (const t of targetList) {
      console.log(`\n▶ 실행: ${t}`);
      await runOnce({ keywordOrUrl: t });
    }
  })().catch((e) => {
    console.error('UNCAUGHT:', e);
    process.exit(1);
  });
})();
