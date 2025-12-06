import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { nanoid } from 'nanoid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// pull named exports we actually have
const { DisconnectReason, useMultiFileAuthState, Browsers } = baileys

// robustly locate socket creator (handles different fork export styles)
const makeWASocket =
  (typeof baileys.default === 'function' && baileys.default) ||
  (typeof baileys.makeWASocket === 'function' && baileys.makeWASocket) ||
  null

if (!makeWASocket) {
  console.error('❌ Could not find makeWASocket in @whiskeysockets/baileys.')
  console.error('Available keys:', Object.keys(baileys))
  throw new Error('makeWASocket function not found in Baileys module')
}

console.log('✅ makeWASocket type:', typeof makeWASocket)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const log = pino({ level: 'info' })

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 3000

// sessions/<SESSION_ID>/ will store Baileys multi-file auth
const SESSIONS_DIR = path.join(__dirname, 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// codes/<LUX~XXXX>.json will store creds.json content (our "DB")
const CODES_DIR = path.join(__dirname, 'codes')
if (!fs.existsSync(CODES_DIR)) fs.mkdirSync(CODES_DIR, { recursive: true })

// in-memory store of sessionId -> shortCode (LUX~XXXXXX)
const sessionResults = new Map()

// track which sessions already sent the short code to WhatsApp
const sentSessionToSelf = new Set()

// generate short external code, e.g. LUX~aB3Xd91K
function generateShortCode() {
  return 'LUX~' + nanoid(8) // adjust length if you want
}

// read creds.json and store it under a short LUX~ code in codes/
function storeSessionAndCode(sessionId, sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json')
    if (!fs.existsSync(credsPath)) {
      log.warn({ sessionId }, 'creds.json not found yet')
      return null
    }

    const credsJson = fs.readFileSync(credsPath, 'utf8')

    // if we already generated a code for this session, reuse it
    let shortCode = sessionResults.get(sessionId)
    if (!shortCode) {
      shortCode = generateShortCode()
      sessionResults.set(sessionId, shortCode)
    }

    const codeFile = path.join(CODES_DIR, `${shortCode}.json`)
    fs.writeFileSync(codeFile, credsJson, 'utf8')

    log.info({ sessionId, shortCode }, 'Stored creds under short code (file DB)')
    return shortCode
  } catch (err) {
    log.error({ err, sessionId }, 'failed to store session code in file DB')
    return null
  }
}

// create a Baileys socket bound to a specific sessionId (multi-file auth)
// opts.ownerJid: JID to send short code to
// opts.mobile: true for pair login (phone), false for QR (web-style)
async function createSocket(sessionId, opts = {}) {
  const { ownerJid, mobile = false } = opts
  const sessionPath = path.join(SESSIONS_DIR, sessionId)
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: mobile ? Browsers.android('Chrome') : Browsers.macOS('Chrome'),
    mobile: !!mobile
  })

  // keep auth up to date & rebuild short code when creds change
  sock.ev.on('creds.update', async () => {
    await saveCreds()
    storeSessionAndCode(sessionId, sessionPath)
    log.info({ sessionId }, 'creds updated & saved')
  })

  // when connection opens, ensure short code stored and (optionally) send to WhatsApp
  sock.ev.on('connection.update', async (update) => {
    const { connection } = update
    if (connection === 'open') {
      await saveCreds()
      const shortCode = storeSessionAndCode(sessionId, sessionPath)

      // send ONLY the short code to WhatsApp, once
      if (shortCode && !sentSessionToSelf.has(sessionId)) {
        try {
          const targetJid = ownerJid || sock.user?.id
          if (targetJid) {
            await sock.sendMessage(targetJid, {
              text:
                `✅ Your LUX session is ready.\n\n` +
                `Short code (keep this safe):\n${shortCode}`
            })
            log.info({ sessionId, targetJid }, 'Sent short code to WhatsApp')
            sentSessionToSelf.add(sessionId)
          } else {
            log.warn({ sessionId }, 'No target JID available to send short code')
          }
        } catch (err) {
          log.error({ err, sessionId }, 'Failed to send short code to WhatsApp')
        }
      }
    }
  })

  return sock
}

/**
 * QR LOGIN
 * GET /api/session/qr
 */
app.get('/api/session/qr', async (req, res) => {
  const sessionId = 'S-' + nanoid(10)
  log.info({ sessionId }, 'QR session requested')

  try {
    // QR login: web-style
    const sock = await createSocket(sessionId, { mobile: false })

    let answered = false

    const timeout = setTimeout(() => {
      if (!answered) {
        answered = true
        log.warn({ sessionId }, 'QR timeout')
        res.status(504).json({ error: 'QR timeout' })
        try {
          sock.ws?.close()
        } catch {}
      }
    }, 60_000)

    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update

      log.info(
        {
          sessionId,
          connection,
          hasQr: !!qr,
          statusCode: lastDisconnect?.error?.output?.statusCode
        },
        'connection.update (qr)'
      )

      if (!answered && qr) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300 })
        answered = true
        clearTimeout(timeout)
        log.info({ sessionId }, 'QR generated')
        return res.json({
          sessionId,
          qr: dataUrl,
          status: 'scan_pending'
        })
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        log.warn({ sessionId, statusCode }, 'QR connection closed')

        if (statusCode === DisconnectReason.restartRequired) {
          log.warn({ sessionId }, 'restartRequired for QR, restarting socket...')
          createSocket(sessionId, { mobile: false }).catch((err) => {
            log.error({ err, sessionId }, 'Error restarting QR socket')
          })
          return
        }

        if (!answered) {
          answered = true
          clearTimeout(timeout)
          return res.status(500).json({
            error: 'connection_closed',
            statusCode,
            shouldReconnect
          })
        }
      }
    })
  } catch (err) {
    log.error({ err, sessionId }, 'Error in /api/session/qr')
    return res.status(500).json({
      error: 'internal_error',
      details: String(err?.message || err)
    })
  }
})

/**
 * PAIR-CODE LOGIN
 * GET /api/session/pair?phone=XXXXXXXXXXX
 */
app.get('/api/session/pair', async (req, res) => {
  const rawPhone = (req.query.phone || '').toString().trim()
  const phone = rawPhone.replace(/[^\d]/g, '')

  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({
      error: 'invalid_phone',
      message: 'phone must be digits only, E.164 without + (ex: 918888888888)'
    })
  }

  const sessionId = 'P-' + nanoid(10)
  log.info({ sessionId, phone }, 'Pair-code session requested')

  try {
    // Pair login: mobile-style socket
    const ownerJid = `${phone}@s.whatsapp.net`
    const sock = await createSocket(sessionId, { ownerJid, mobile: true })

    let answered = false
    let requested = false

    const timeout = setTimeout(() => {
      if (!answered) {
        answered = true
        log.warn({ sessionId }, 'Pair-code timeout')
        res.status(504).json({ error: 'pair_timeout' })
        try {
          sock.ws?.close()
        } catch {}
      }
    }, 60_000)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update

      log.info(
        {
          sessionId,
          connection,
          statusCode: lastDisconnect?.error?.output?.statusCode
        },
        'connection.update (pair)'
      )

      // request pairing code once when starting / connecting
      if (!requested && (connection === 'connecting' || connection === 'open')) {
        requested = true
        try {
          let code = await sock.requestPairingCode(phone)
          if (code && typeof code === 'string') {
            code = code.match(/.{1,4}/g)?.join('-') || code
          }

          if (!answered) {
            answered = true
            clearTimeout(timeout)
            log.info({ sessionId, phone, code }, 'Pairing code generated')
            return res.json({
              sessionId,
              phone,
              code,
              status: 'pair_code_generated'
            })
          }
        } catch (err) {
          if (!answered) {
            answered = true
            clearTimeout(timeout)
            log.error({ err, sessionId }, 'Error generating pair code')
            return res.status(500).json({
              error: 'pair_code_error',
              details: String(err?.message || err)
            })
          }
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        log.warn({ sessionId, statusCode }, 'Pair connection closed')

        if (statusCode === DisconnectReason.restartRequired) {
          log.warn({ sessionId }, 'restartRequired for pair, restarting socket...')
          createSocket(sessionId, { ownerJid, mobile: true }).catch((err) => {
            log.error({ err, sessionId }, 'Error restarting pair socket')
          })
          return
        }

        if (!answered) {
          answered = true
          clearTimeout(timeout)
          return res.status(500).json({
            error: 'connection_closed',
            statusCode,
            shouldReconnect
          })
        }
      }
    })
  } catch (err) {
    log.error({ err, sessionId }, 'Error in /api/session/pair root try')
    return res.status(500).json({
      error: 'pair_code_error',
      details: String(err?.message || err)
    })
  }
})

/**
 * RESULT POLLING
 * GET /api/session/result/:id
 * -> returns short LUX~XXXXXX code (if ready)
 */
app.get('/api/session/result/:id', (req, res) => {
  const sessionId = req.params.id
  const code = sessionResults.get(sessionId) || null

  return res.json({
    sessionId,
    ready: !!code,
    code
  })
})

/**
 * FETCH CREDS BY SHORT CODE
 * GET /api/session/creds/:code
 * -> returns stored creds.json for that LUX~ code
 */
app.get('/api/session/creds/:code', (req, res) => {
  const code = req.params.code
  const filePath = path.join(CODES_DIR, `${code}.json`)

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'not_found',
      message: 'No creds found for this code'
    })
  }

  try {
    const credsJson = fs.readFileSync(filePath, 'utf8')
    return res.json({
      code,
      creds: JSON.parse(credsJson)
    })
  } catch (err) {
    log.error({ err, code }, 'Error reading creds.json for code')
    return res.status(500).json({
      error: 'read_error',
      details: String(err?.message || err)
    })
  }
})

app.listen(PORT, () => {
  log.info(`LUX Session server running on port ${PORT}`)
})
