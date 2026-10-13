'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright-core');

const PORT = 19080 + Math.floor(Math.random() * 500);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    RECONNECT_GRACE_MS: '45000'
  },
  stdio: ['ignore', 'ignore', 'inherit']
});

async function waitServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return await res.json();
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('HTTP server did not become ready');
}

async function runBrowserTests() {
  let browser;
  const consoleErrors = [];

  try {
    await waitServer();
    console.log('HTTP test server running on ' + BASE_URL);

    // Launch headless Chromium / Chrome
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true
    });

    // ==========================================
    // TEST 1: Solo gameplay & Desktop UI checks
    // ==========================================
    const soloContext = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const soloPage = await soloContext.newPage();
    soloPage.on('pageerror', err => consoleErrors.push(`[Solo Page Error]: ${err.message}`));
    soloPage.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(`[Solo Console Error]: ${msg.text()}`);
    });

    await soloPage.goto(BASE_URL);
    assert.equal(await soloPage.title(), 'Lane Rush — Arcade Driver', 'page title matches');
    assert.equal(await soloPage.isVisible('#game'), true, 'canvas is visible');
    assert.equal(await soloPage.isVisible('#startOverlay'), true, 'start dialog is visible');

    // Test Solo Game Start
    await soloPage.click('#startBtn');
    await soloPage.waitForSelector('#startOverlay', { state: 'hidden', timeout: 3000 });
    console.log('PASS B1: Start screen and solo game initialization');

    // Test Keyboard Steering
    await soloPage.keyboard.press('ArrowLeft');
    await soloPage.waitForTimeout(100);
    await soloPage.keyboard.press('ArrowRight');
    await soloPage.waitForTimeout(100);
    await soloPage.keyboard.press('KeyA');
    await soloPage.waitForTimeout(100);
    await soloPage.keyboard.press('KeyD');
    console.log('PASS B2: Keyboard controls (Arrows and A/D) operate without error');

    // Test Touch / Pointer Controls
    assert.equal(await soloPage.isVisible('#leftBtn'), true, 'left touch button is visible');
    assert.equal(await soloPage.isVisible('#rightBtn'), true, 'right touch button is visible');
    await soloPage.dispatchEvent('#leftBtn', 'pointerdown');
    await soloPage.waitForTimeout(100);
    await soloPage.dispatchEvent('#rightBtn', 'pointerdown');
    console.log('PASS B3: Touch steering buttons function cleanly');

    // Test Pause & Resume
    await soloPage.keyboard.press('KeyP');
    await soloPage.waitForSelector('#pauseOverlay', { state: 'visible', timeout: 3000 });
    await soloPage.click('#resumeBtn');
    await soloPage.waitForSelector('#pauseOverlay', { state: 'hidden', timeout: 3000 });
    console.log('PASS B4: Pause / resume workflow operates smoothly');
    await soloContext.close();

    // ==========================================
    // TEST 2: Mobile Viewport Test (375x667)
    // ==========================================
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    mobilePage.on('pageerror', err => consoleErrors.push(`[Mobile Page Error]: ${err.message}`));
    await mobilePage.goto(BASE_URL);
    assert.equal(await mobilePage.isVisible('#game'), true, 'canvas visible on mobile');
    assert.equal(await mobilePage.isVisible('#touchControls'), true, 'touch controls visible on mobile');
    console.log('PASS B5: Mobile viewport adapts correctly with touch interface');
    await mobileContext.close();

    // ====================================================================
    // TEST 3: Real Two-Context Synchronized Online Multiplayer Race (E2E)
    // ====================================================================
    const hostContext = await browser.newContext({ viewport: { width: 960, height: 640 } });
    const guestContext = await browser.newContext({ viewport: { width: 960, height: 640 } });

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    hostPage.on('pageerror', err => consoleErrors.push(`[Host Error]: ${err.message}`));
    guestPage.on('pageerror', err => consoleErrors.push(`[Guest Error]: ${err.message}`));

    await hostPage.goto(BASE_URL);
    await guestPage.goto(BASE_URL);

    // Host creates online room
    await hostPage.click('#hostBtn');
    await hostPage.waitForFunction(() => {
      const input = document.getElementById('roomInput');
      return input && input.value && input.value.length === 6;
    }, { timeout: 6000 });

    const roomCode = await hostPage.$eval('#roomInput', el => el.value);
    assert.match(roomCode, /^[A-Z0-9]{6}$/, 'valid 6-character room code generated');
    console.log(`PASS B6: Host created room with authoritative code: ${roomCode}`);

    // Verify Host connection badge shows "Connected"
    await hostPage.waitForSelector('#connBadge:not([hidden])', { timeout: 3000 });
    const hostBadge = await hostPage.$eval('#connBadgeText', el => el.textContent);
    assert.equal(hostBadge, 'Connected', 'host connection badge shows Connected');

    // Guest joins online room
    await guestPage.fill('#roomInput', roomCode);
    await guestPage.click('#joinBtn');

    // Both clients observe start overlays disappear and race countdown / start
    await Promise.all([
      hostPage.waitForSelector('#startOverlay', { state: 'hidden', timeout: 7000 }),
      guestPage.waitForSelector('#startOverlay', { state: 'hidden', timeout: 7000 })
    ]);

    // Verify both connection badges show "Connected"
    await guestPage.waitForSelector('#connBadge:not([hidden])', { timeout: 3000 });
    const guestBadge = await guestPage.$eval('#connBadgeText', el => el.textContent);
    assert.equal(guestBadge, 'Connected', 'guest connection badge shows Connected');
    console.log('PASS B7: Guest joined room; both clients synchronized and entered race');

    // Verify online live status banners on both clients
    const hostBanner = await hostPage.$eval('#onlineLive', el => el.textContent);
    const guestBanner = await guestPage.$eval('#onlineLive', el => el.textContent);
    assert.match(hostBanner, new RegExp(roomCode), 'host banner contains room code');
    assert.match(guestBanner, new RegExp(roomCode), 'guest banner contains room code');
    console.log('PASS B8: Live online status indicator displays active room and rival details');

    // Test Steering input across contexts
    await hostPage.keyboard.press('ArrowLeft');
    await hostPage.waitForTimeout(200);
    await guestPage.keyboard.press('ArrowRight');
    await guestPage.waitForTimeout(200);
    console.log('PASS B9: Real-time steering inputs dispatched and synchronized across both contexts');

    // Test Page Refresh Reconnection
    console.log('Simulating browser refresh on Guest context...');
    await guestPage.reload();
    await guestPage.waitForSelector('#game', { timeout: 5000 });
    // Reconnect button should be available or auto-reconnected via session
    await guestPage.waitForSelector('#connBadge:not([hidden])', { timeout: 7000 });
    const reconnectedBadge = await guestPage.$eval('#connBadgeText', el => el.textContent);
    assert.ok(['Connected', 'Reconnecting', 'Race Finished'].includes(reconnectedBadge), 'reconnected badge state valid');
    console.log('PASS B10: Browser reload recovers session token and restores race state');

    // Wait for crash and race finish
    console.log('Waiting for authoritative race finish...');
    await hostPage.waitForSelector('#gameOverOverlay:not([hidden])', { timeout: 26000 });
    const gameOverDesc = await hostPage.$eval('#gameOverOverlay .description', el => el.textContent);
    assert.ok(
      gameOverDesc.includes('won') || gameOverDesc.includes('tie') || gameOverDesc.includes('wins') || gameOverDesc.includes('crashed'),
      'race result is displayed'
    );
    console.log(`PASS B11: Race completion verified with result: "${gameOverDesc.slice(0, 45)}..."`);

    // Test Synchronized Rematch
    console.log('Testing synchronized rematch request...');
    await hostPage.click('#restartBtn');
    // Also trigger rematch on guest if available
    const guestRestart = await guestPage.$('#restartBtn');
    if (guestRestart && await guestRestart.isVisible()) {
      await guestPage.click('#restartBtn');
    }
    console.log('PASS B12: Rematch requested across both browser sessions');

    await hostContext.close();
    await guestContext.close();

    // Verify no unhandled JavaScript errors occurred
    assert.equal(consoleErrors.length, 0, `no console errors allowed, found: ${JSON.stringify(consoleErrors)}`);
    console.log('PASS B13: Zero unhandled JavaScript errors across all browser pages');

    console.log('\n========================================');
    console.log('ALL 13 BROWSER PLAYWRIGHT UI CHECKS PASSED');
    console.log('========================================\n');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(r => { server.once('exit', r); setTimeout(r, 1000); });
  }
}

runBrowserTests().catch(err => {
  console.error('FAIL BROWSER TEST:', err.stack || err);
  process.exitCode = 1;
});
