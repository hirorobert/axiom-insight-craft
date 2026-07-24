#!/usr/bin/env node
/**
 * Route Smoke Test — Playwright
 *
 * Opens each /command and /workspace/:companyId/:periodYear/* route against the
 * running dev/preview server and asserts:
 *   - HTTP-level: no redirect loop, final status 200
 *   - DOM: <title> present and non-empty; <h1>/main heading renders
 *   - Params: companyId + periodYear survive to the final URL (workspace routes)
 *   - No uncaught console errors
 *
 * Auth-gated routes are skipped when LOVABLE_BROWSER_AUTH_STATUS !== 'injected'
 * and reported as SKIPPED (not FAIL) so the script is safe to run unauthenticated.
 *
 * Env:
 *   BASE_URL          default http://localhost:8080
 *   SMOKE_COMPANY_ID  default 00000000-0000-0000-0000-000000000001
 *   SMOKE_PERIOD_YEAR default 2025
 *
 * Exit code 0 = all PASS/SKIP. Exit code 1 = one or more FAIL.
 */

import { chromium } from 'playwright'

const BASE_URL     = process.env.BASE_URL          ?? 'http://localhost:8080'
const COMPANY_ID   = process.env.SMOKE_COMPANY_ID  ?? '00000000-0000-0000-0000-000000000001'
const PERIOD_YEAR  = process.env.SMOKE_PERIOD_YEAR ?? '2025'
const AUTH_STATUS  = process.env.LOVABLE_BROWSER_AUTH_STATUS ?? 'signed_out'
const AUTHENTICATED = AUTH_STATUS === 'injected'

const WORKSPACE_STAGES = [
  '',            // overview (index route)
  'prepare',
  'reconcile',
  'statements',
  'tax',
  'compliance',
  'filing',
  'monitor',
]

const ROUTES = [
  { path: '/command', requiresAuth: false, checkParams: false },
  ...WORKSPACE_STAGES.map((stage) => ({
    path: `/workspace/${COMPANY_ID}/${PERIOD_YEAR}${stage ? `/${stage}` : ''}`,
    requiresAuth: true,
    checkParams: true,
  })),
]

const MAX_REDIRECTS = 5

function fmt(status, label, detail = '') {
  const color = status === 'PASS' ? '\x1b[32m' : status === 'FAIL' ? '\x1b[31m' : '\x1b[33m'
  return `${color}${status}\x1b[0m  ${label}${detail ? '  ' + detail : ''}`
}

async function testRoute(browser, route) {
  const { path, requiresAuth, checkParams } = route
  const url = `${BASE_URL}${path}`

  if (requiresAuth && !AUTHENTICATED) {
    return { path, status: 'SKIP', reason: 'auth not injected' }
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  const redirects = []
  page.on('response', (resp) => {
    if (resp.status() >= 300 && resp.status() < 400 && resp.url().startsWith(BASE_URL)) {
      redirects.push(resp.url())
    }
  })

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    if (!resp) return { path, status: 'FAIL', reason: 'no response' }
    if (resp.status() !== 200) {
      return { path, status: 'FAIL', reason: `HTTP ${resp.status()}` }
    }

    if (redirects.length > MAX_REDIRECTS) {
      return { path, status: 'FAIL', reason: `redirect loop (${redirects.length})` }
    }

    // Wait for React render
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

    const title = (await page.title()).trim()
    if (!title) return { path, status: 'FAIL', reason: 'empty <title>' }

    const finalUrl = page.url()
    // Auth redirect: workspace routes redirect to /auth when signed out
    if (requiresAuth && finalUrl.includes('/auth')) {
      return { path, status: 'SKIP', reason: 'redirected to /auth' }
    }

    if (checkParams) {
      const u = new URL(finalUrl)
      if (!u.pathname.includes(COMPANY_ID)) {
        return { path, status: 'FAIL', reason: `companyId lost — final ${u.pathname}` }
      }
      if (!u.pathname.includes(`/${PERIOD_YEAR}`)) {
        return { path, status: 'FAIL', reason: `periodYear lost — final ${u.pathname}` }
      }
    }

    // Assert something rendered (main region or heading)
    const hasContent = await page.evaluate(() => {
      const main = document.querySelector('main, [role="main"], h1, h2')
      return !!main && (main.textContent ?? '').trim().length > 0
    })
    if (!hasContent) return { path, status: 'FAIL', reason: 'no rendered heading/main' }

    if (consoleErrors.length > 0) {
      return {
        path,
        status: 'FAIL',
        reason: `console errors: ${consoleErrors.slice(0, 2).join(' | ')}`,
      }
    }

    return { path, status: 'PASS', title, finalUrl }
  } catch (err) {
    return { path, status: 'FAIL', reason: err.message }
  } finally {
    await context.close()
  }
}

async function main() {
  console.log(`\nRoute smoke test → ${BASE_URL}`)
  console.log(`Auth: ${AUTHENTICATED ? 'INJECTED' : 'SIGNED OUT (workspace routes will SKIP)'}\n`)

  const browser = await chromium.launch({ headless: true })
  const results = []
  for (const route of ROUTES) {
    const r = await testRoute(browser, route)
    results.push(r)
    console.log(fmt(r.status, r.path, r.reason ?? r.title ?? ''))
  }
  await browser.close()

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length

  console.log(`\n${pass} passed · ${fail} failed · ${skip} skipped`)
  console.log(fail === 0 ? 'VERDICT: CLEAN' : 'VERDICT: FAIL')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})